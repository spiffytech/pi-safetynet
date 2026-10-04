/**
 * job-watch-tool.ts — THE `job_watch` tool: one registration code path for the
 * parent session and for subagent children. Identical name, schema, actions,
 * and messages everywhere; the injected JobWatchApi decides scope (whose
 * watches), fire routing (wake parent vs resume child), and where notices go.
 *
 * Actions: run (launch detached + watch), attach (adopt an already-running,
 * already-backgrounded process), register (watch a condition), list, tail,
 * cancel. Waiting never involves a sleeping agent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { JobWatchApi, JobWatchCreateResult, WatchTrigger, WatchView } from "./watch.ts";

export const JOB_WATCH_TOOL_NAME = "job_watch";

/** Build a WatchTrigger from flat tool params. */
export function buildTrigger(params: {
	pid?: number;
	path?: string;
	pattern?: string;
	deadlineSeconds?: number;
	quietForSeconds?: number;
	heartbeatSeconds?: number;
}): { triggers?: WatchTrigger[]; guardPid?: number; error?: never } | { triggers?: never; guardPid?: never; error: string } {
	const wantsQuiet = params.quietForSeconds !== undefined;
	const wantsFile = params.path !== undefined && params.pattern !== undefined;
	const wantsDeadline = params.deadlineSeconds !== undefined;
	if (params.pattern !== undefined && params.path === undefined) {
		return { error: "file trigger needs both path and pattern" };
	}
	// A bare path is ambiguous — but path+quietForSeconds is a silence watch.
	if (params.path !== undefined && params.pattern === undefined && !wantsQuiet) {
		return { error: "file trigger needs both path and pattern (or path + quietForSeconds)" };
	}
	// Every condition the caller named becomes a trigger — ANY of them firing
	// wakes/resumes. Conditions compose; nothing is silently dropped.
	const conditions: WatchTrigger[] = [];
	if (wantsFile) {
		const bad = validatePatternRegex(params.pattern!);
		if (bad) return { error: bad };
		conditions.push({ kind: "file-contains", path: params.path!, pattern: params.pattern! });
	}
	if (wantsQuiet) {
		if (!(params.quietForSeconds! >= 60)) return { error: "quietForSeconds must be >= 60 (silence is not speed; give the job room)" };
		if (!params.path) return { error: "quietForSeconds needs a path (the log whose silence to watch)" };
		conditions.push({ kind: "file-quiet", path: params.path, seconds: params.quietForSeconds! });
	}
	if (wantsDeadline) {
		if (!(params.deadlineSeconds! > 0)) return { error: "deadlineSeconds must be > 0" };
		conditions.push({ kind: "deadline", at: Date.now() + params.deadlineSeconds! * 1000 });
	}
	if (params.pid !== undefined) {
		// Alone, a pid IS the condition; alongside others it guards them — its
		// death fires the watch even if no condition ever happens.
		if (conditions.length === 0) return { triggers: [{ kind: "pid-exit", pid: params.pid }] };
		return { triggers: conditions, guardPid: params.pid };
	}
	if (conditions.length === 0) {
		if (params.heartbeatSeconds === undefined) {
			return { error: "job_watch needs a trigger (pid | path+pattern | quietForSeconds | deadlineSeconds) or heartbeatSeconds" };
		}
		return {}; // heartbeat-only
	}
	return { triggers: conditions };
}

/**
 * Register-time pattern vetting for an incompetent (not malicious) author:
 * compile check, length cap, and a worst-case probe. The probe RUNS IN A
 * KILLABLE SUBPROCESS — measuring in-process cannot bound a pattern that
 * explodes exponentially (the measurement itself would hang). If the
 * adversarial case can't finish in 250ms there, it must never run inside pi's
 * event loop on real log data.
 */
export function validatePatternRegex(pattern: string): string | null {
	if (pattern.length > 500) return "pattern too long (max 500 characters)";
	try {
		new RegExp(pattern, "m");
	} catch (err) {
		return `invalid pattern regex: ${err}`;
	}
	const evil = JSON.stringify("a".repeat(512) + "\n" + "ab".repeat(256) + "\n");
	const probe = `const re = new RegExp(${JSON.stringify(pattern)}, "m"); re.test(${evil}); re.test(${evil} + "b");`;
	const res = spawnSync(process.execPath, ["-e", probe], { timeout: 250, stdio: "ignore" });
	if (res.error || res.signal || res.status !== 0) {
		return "pattern rejected: too slow or unsafe (catastrophic backtracking risk)";
	}
	return null;
}

/** One /proc/<pid>/stat read: both the sid (session) and start ticks. */
export function readProcStat(pid: number): { sid?: number; start?: number } {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const sid = Number(tail[3]);
		const start = Number(tail[19]);
		return {
			...(Number.isFinite(sid) ? { sid } : {}),
			...(Number.isFinite(start) ? { start } : {}),
		};
	} catch {
		return {};
	}
}

/** Kernel boot id: if it changes, everything from the previous boot is gone. */
export function readBootId(): string | undefined {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
	} catch {
		return undefined;
	}
}

export interface PidSurvival {
	alive: boolean;
	/** Own-session leader: pi cannot reach it. */
	detached: boolean;
	verdict: string;
	notice?: string;
}

/**
 * Teardown survival of a live pid. pi kills its own session's process groups
 * and tracked children on abort/SIGTERM/SIGHUP/exit; a process that leads its
 * own session (setsid) — or lives in another session entirely — is out of
 * reach. Reads /proc/<pid>/stat (fields after the last ')': ppid, pgrp, sid).
 */
export function describePidSurvival(pid: number, hostPid = process.pid): PidSurvival {
	const sid = readProcStat(pid).sid;
	if (sid === undefined) {
		// No /proc (non-Linux): fall back to signal-0 liveness instead of
		// misreporting a live pid as gone.
		try {
			process.kill(pid, 0);
			return { alive: true, detached: false, verdict: "alive — teardown survival unverifiable here (no /proc)" };
		} catch {
			return { alive: false, detached: false, verdict: "pid is gone" };
		}
	}
	const hostSid = readProcStat(hostPid).sid;
	if (sid === pid) {
		return {
			alive: true,
			detached: true,
			verdict: "✓ own session — survives pi exiting",
		};
	}
	if (hostSid !== undefined && sid === hostSid) {
		return {
			alive: true,
			detached: false,
			verdict: "⚠ in pi's session — will be killed when pi exits or aborts",
			notice:
				`⚠ job_watch: pid ${pid} shares pi's session — it WILL die when pi exits or the turn aborts. ` +
				`Remedy: relaunch it detached (job_watch run, or setsid … &), then attach to that.`,
		};
	}
	return {
		alive: true,
		detached: true,
		verdict: "✓ outside pi's session — survives pi exiting",
	};
}

function triggerDesc(t: WatchTrigger | undefined): string {
	if (!t) return "heartbeat only";
	switch (t.kind) {
		case "pid-exit": return `pid ${t.pid} exits`;
		case "file-contains": return `regex /${t.pattern}/m on ${t.path}`;
		case "file-quiet": return `no output in ${t.path} for ${t.seconds}s`;
		case "deadline": return `deadline ${new Date(t.at).toISOString()}`;
	}
}

/** One line per watch for `job_watch list`. */
export function formatWatchViews(views: Array<Pick<WatchView, "id" | "state" | "label"> & Partial<WatchView>>): string {
	return views
		.map((v) => {
			const parts = [`${v.id} [${v.state}]`, v.label];
			const triggerSet = v.triggers?.length ? v.triggers : v.trigger ? [v.trigger] : [];
			if (triggerSet.length > 0) parts.push(`trigger: ${triggerSet.map(triggerDesc).join(" | ")}`);
			if (v.state === "pending" && v.heartbeatMs) parts.push(`heartbeat ${Math.round(v.heartbeatMs / 1000)}s`);
			if (v.guardPid !== undefined) parts.push(`guard:pid ${v.guardPid}`);
			if (v.claimedBy !== undefined) parts.push(`held by session ${v.claimedBy}`);
			if (v.survival) parts.push(v.survival);
			if (v.verdict) parts.push(`verdict: ${v.verdict}`);
			if (v.lastLine) parts.push(`last: ${v.lastLine}`);
			return parts.join(" | ");
		})
		.join("\n");
}

function formatCreate(
	res: JobWatchCreateResult,
	action: string,
	triggers: WatchTrigger[],
	heartbeatMs?: number,
	guardPid?: number,
	lifetimeMinutes?: number,
): string {
	if (!res.ok) return res.reason;
	const parts = [
		`job_watch ${res.id}: ${
			action === "run"
				? `spawned pid ${res.pid} detached, logging to ${res.logPath}`
				: action === "attach"
					? `attached to pid ${(triggers[0] as { pid?: number } | undefined)?.pid ?? "?"}`
					: "registered"
		} [${triggers.map(triggerDesc).join(" | ")}]`,
	];
	if (guardPid !== undefined) parts.push(`guard: death of pid ${guardPid} fires it too`);
	if (heartbeatMs) parts.push(`heartbeat ${Math.round(heartbeatMs / 1000)}s`);
	if (lifetimeMinutes !== undefined) parts.push(`lifetime ${lifetimeMinutes}min`);
	if (res.survival) parts.push(res.survival);
	if (res.logPath && action !== "run") parts.push(`log: ${res.logPath}`);
	parts.push("You will be notified when it fires.");
	return parts.join(" | ");
}

/** Register the one `job_watch` tool against a scope's api. */
export function registerJobWatchTool(pi: ExtensionAPI, api: JobWatchApi): void {
	pi.registerTool({
		name: JOB_WATCH_TOOL_NAME,
		label: "Job Watch",
		description:
			"Watch background work without babysitting: notified on pid-exit, file regex, silence, deadline, or heartbeat — any watch can carry a pid so death always wakes. " +
			"Prefer over sleep/poll loops. Actions: run (launch detached + watch) | attach (adopt work you backgrounded) | register | list | tail | extend | cancel.",
		promptSnippet: "Run/watch background jobs, get notified on events",
		namespace: { name: "pi-submarine", description: "background subagents and job watches" },
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "run|attach|register|list|tail|extend|cancel" })),
			command: Type.Optional(Type.String({ description: "run: command (detached, survives pi)" })),
			pid: Type.Optional(Type.Number({ description: "fires on exit; alongside another trigger, death-guards it too" })),
			path: Type.Optional(Type.String({ description: "file to watch" })),
			pattern: Type.Optional(Type.String({ description: "regex (m-flagged; ^…$ = whole line)" })),
			deadlineSeconds: Type.Optional(Type.Number({ description: "fire in N seconds" })),
			quietForSeconds: Type.Optional(Type.Number({ description: "fire after N s silent (≥60)" })),
			lifetimeMinutes: Type.Optional(Type.Number({ description: "minutes (default 30; extend renews)" })),
			heartbeatSeconds: Type.Optional(Type.Number({ description: "notify every N s (≥60; each costs a turn)" })),
			logPath: Type.Optional(Type.String({ description: "log for previews / run output" })),
			label: Type.Optional(Type.String({ description: "display name" })),
			id: Type.Optional(Type.String({ description: "watch id (tail/extend/cancel)" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Bare `pid:` means "adopt this process" — the attach path (survival
			// verdict + log adoption) is what a pid-only call wants.
			const pidOnly =
				params.pid !== undefined &&
				params.path === undefined &&
				params.pattern === undefined &&
				params.deadlineSeconds === undefined &&
				params.quietForSeconds === undefined;
			const action = (params.action ?? (pidOnly ? "attach" : "register")).toLowerCase();
			const heartbeatMs = params.heartbeatSeconds !== undefined ? params.heartbeatSeconds * 1000 : undefined;

			if (action === "list") {
				const views = api.list();
				return {
					content: [{ type: "text", text: views.length ? formatWatchViews(views) : "No watches." }],
					details: { watches: views },
				};
			}
			if (action === "tail") {
				if (!params.id) return { content: [{ type: "text", text: "tail needs a watch id" }], details: { error: "missing id" } };
				const text = api.tail(params.id, 20);
				return { content: [{ type: "text", text }], details: { watchId: params.id } };
			}
			if (action === "cancel") {
				if (!params.id) return { content: [{ type: "text", text: "cancel needs a watch id" }], details: { error: "missing id" } };
				const res = api.cancel(params.id);
				return { content: [{ type: "text", text: res.reason }], details: { cancelled: res.ok } };
			}
			if (action === "extend") {
				if (!params.id) return { content: [{ type: "text", text: "extend needs a watch id" }], details: { error: "missing id" } };
				if (!(params.lifetimeMinutes !== undefined && params.lifetimeMinutes > 0)) {
					return { content: [{ type: "text", text: "extend needs lifetimeMinutes (> 0)" }], details: { error: "missing lifetimeMinutes" } };
				}
				const res = api.extend(params.id, params.lifetimeMinutes);
				return { content: [{ type: "text", text: res.reason }], details: { extended: res.ok } };
			}

			let res: JobWatchCreateResult;
			let triggers: WatchTrigger[] = [];
			let guardPid: number | undefined;
			if (action === "run") {
				if (!params.command) return { content: [{ type: "text", text: "run needs a command" }], details: { error: "missing command" } };
				res = await api.run({
					command: params.command,
					...(params.logPath ? { logPath: params.logPath } : {}),
					...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
					...(params.label ? { label: params.label } : {}),
					...(params.lifetimeMinutes !== undefined ? { lifetimeMinutes: params.lifetimeMinutes } : {}),
				}, ctx);
				if (res.ok) triggers = [{ kind: "pid-exit", pid: res.pid! }];
			} else if (action === "attach") {
				if (params.pid === undefined) return { content: [{ type: "text", text: "attach needs a pid" }], details: { error: "missing pid" } };
				res = api.attach({
					pid: params.pid,
					...(params.logPath ? { logPath: params.logPath } : {}),
					...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
					...(params.label ? { label: params.label } : {}),
					...(params.lifetimeMinutes !== undefined ? { lifetimeMinutes: params.lifetimeMinutes } : {}),
				});
				triggers = [{ kind: "pid-exit", pid: params.pid }];
			} else {
				const built = buildTrigger(params);
				if ("error" in built) return { content: [{ type: "text", text: built.error }], details: { error: built.error } };
				triggers = built.triggers ?? [];
				guardPid = built.guardPid;
				res = api.register({
					...(triggers.length ? { triggers } : {}),
					...(built.guardPid !== undefined ? { guardPid: built.guardPid } : {}),
					...(params.logPath ? { logPath: params.logPath } : {}),
					...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
					...(params.label ? { label: params.label } : {}),
					...(params.lifetimeMinutes !== undefined ? { lifetimeMinutes: params.lifetimeMinutes } : {}),
				});
			}

			if (res.ok && res.notice) api.notifyParent(res.notice);
			const text =
				formatCreate(res, action, triggers, heartbeatMs, guardPid, params.lifetimeMinutes) +
				(res.ok && res.notice ? `\n${res.notice}` : "");
			return { content: [{ type: "text", text }], details: res.ok ? { watchId: res.id, ...(res.notice ? { notice: res.notice } : {}) } : { error: res.reason } };
		},
	});
}
