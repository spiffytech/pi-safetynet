/**
 * job-watch-api.ts — the ONE JobWatchApi implementation behind the `job_watch`
 * tool, for the parent and for subagent children alike. Scoping is a
 * constructor option (parent sees all watches; a child only its own), so both
 * cases run the exact same code path.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	describePidSurvival,
	type JobWatchApi,
	type JobWatchCreateResult,
	type WatchInput,
	type WatchOwner,
	type WatchView,
} from "pi-submarine-core";
import { WatchManager, WATCH_EXIT_MARKER } from "./watches.ts";

/** `{ block, reason }` to refuse a `run` command (the normal bash gate). */
export type CommandVerdict = { block: boolean; reason: string } | undefined;

export interface JobWatchApiOptions {
	/** Live manager (lazily: tools register before session_start creates it). */
	manager(): WatchManager | undefined;
	/** Owner recorded on every watch created through this api. */
	owner: WatchOwner;
	/** Parent scope sees and cancels every watch; child scope only its own. */
	global: boolean;
	/** Permission gate for `run` commands — same ruleset as a bash call. */
	approveCommand(command: string, ctx: ExtensionContext): Promise<CommandVerdict>;
	/** Push a notice to the deciding model (the parent). */
	notifyParent(text: string): void;
}

/** Best-effort log adoption: if the process writes stdout to a file, tail it. */
function adoptFd1(pid: number): string | undefined {
	try {
		const target = readlinkSync(`/proc/${pid}/fd/1`);
		if (statSync(target).isFile()) return target;
	} catch {
		/* pipe/tty or gone: not capturable */
	}
	return undefined;
}

export function createJobWatchApi(opts: JobWatchApiOptions): JobWatchApi {
	/** Register a pid-exit watch carrying a teardown-survival verdict. */
	function attachPid(pid: number, input: WatchInput): JobWatchCreateResult {
		const manager = opts.manager();
		if (!manager) return { ok: false, reason: "watch manager unavailable" };
		const survival = describePidSurvival(pid);
		const res = manager.register(opts.owner, {
			...input,
			trigger: { kind: "pid-exit", pid },
			survival: survival.verdict,
			label: input.label ?? `pid ${pid}`,
		});
		if (!res.ok) return res;
		return {
			ok: true,
			id: res.id,
			pid,
			...(input.logPath ? { logPath: input.logPath } : {}),
			survival: survival.verdict,
			...(survival.notice ? { notice: survival.notice } : {}),
		};
	}

	return {
		register(input) {
			const manager = opts.manager();
			if (!manager) return { ok: false, reason: "watch manager unavailable" };
			if (input.trigger?.kind === "pid-exit") {
				return attachPid(input.trigger.pid, input);
			}
			const res = manager.register(opts.owner, input);
			return res.ok ? { ok: true, id: res.id } : res;
		},

		attach({ pid, logPath, label, heartbeatMs, lifetimeMinutes }) {
			const log = logPath ?? adoptFd1(pid);
			return attachPid(pid, {
				...(log ? { logPath: log } : {}),
				...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
				...(lifetimeMinutes !== undefined ? { lifetimeMinutes } : {}),
				...(label ? { label } : {}),
			});
		},

		async run({ command, logPath, label, heartbeatMs, lifetimeMinutes }, ctx) {
			const manager = opts.manager();
			if (!manager) return { ok: false, reason: "watch manager unavailable" };
			if (process.platform === "win32") {
				return {
					ok: false,
					reason:
						"job_watch run is unavailable on Windows (it needs bash + detached-session semantics). " +
						"Launch the job yourself and use attach/register — file, quiet, deadline and heartbeat watches work here.",
				};
			}
			// Route the command through the same permission gate a bash call gets,
			// so `run` can never smuggle an unchecked command past the ruleset.
			const verdict = await opts.approveCommand(command, ctx);
			if (verdict?.block) return { ok: false, reason: `Denied: ${verdict.reason}` };
			const log = logPath ?? join(ctx.cwd, `.pi-submarine-watch-${Date.now()}.log`);
			mkdirSync(dirname(log), { recursive: true });
			const fd = openSync(log, "a");
			// HUP-proof + own session: pi dying must not take the job with it. The
			// exit marker gives restarts a clean "finished vs killed" verdict.
			const wrapper = `trap '' HUP\n${command}\necho "${WATCH_EXIT_MARKER}$?"`;
			const child = spawn("bash", ["-c", wrapper], {
				detached: true,
				stdio: ["ignore", fd, fd],
				cwd: ctx.cwd,
			});
			child.unref();
			closeSync(fd);
			if (!child.pid) return { ok: false, reason: "Failed to spawn the command." };
			return attachPid(child.pid, {
				logPath: log,
				label: label ?? `run: ${command.slice(0, 60)}`,
				...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
				...(lifetimeMinutes !== undefined ? { lifetimeMinutes } : {}),
			});
		},

		list(): WatchView[] {
			const manager = opts.manager();
			if (!manager) return [];
			return opts.global ? manager.list() : manager.list(opts.owner);
		},

		tail(id, n) {
			const manager = opts.manager();
			if (!manager) return "watch manager unavailable";
			return manager.tail(id, n);
		},

		cancel(id) {
			const manager = opts.manager();
			if (!manager) return { ok: false, reason: "watch manager unavailable" };
			return manager.cancel(id, opts.global ? undefined : opts.owner);
		},

		extend(id, lifetimeMinutes) {
			const manager = opts.manager();
			if (!manager) return { ok: false, reason: "watch manager unavailable" };
			return manager.extend(id, lifetimeMinutes, opts.global ? undefined : opts.owner);
		},

		notifyParent(text) {
			opts.notifyParent(text);
		},
	};
}
