import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { buildTrigger, describePidSurvival, formatWatchViews, registerJobWatchTool, JOB_WATCH_TOOL_NAME } from "./job-watch-tool.ts";
import type { JobWatchApi, JobWatchCreateResult, WatchView } from "./watch.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("buildTrigger", () => {
	it("builds pid, file, and deadline triggers", () => {
		assert.deepEqual(buildTrigger({ pid: 42 }), { trigger: { kind: "pid-exit", pid: 42 } });
		assert.deepEqual(buildTrigger({ path: "/tmp/x", pattern: "DONE" }), {
			trigger: { kind: "file-contains", path: "/tmp/x", pattern: "DONE" },
		});
		const deadline = buildTrigger({ deadlineSeconds: 5 });
		assert.equal((deadline.trigger as { kind: string }).kind, "deadline");
	});

	it("rejects triggerless watches and half-specified file triggers", () => {
		assert.match((buildTrigger({}) as { error: string }).error, /needs a trigger/);
		assert.match((buildTrigger({ path: "/tmp/x" }) as { error: string }).error, /both path and pattern/);
		assert.match((buildTrigger({ pattern: "x" }) as { error: string }).error, /both path and pattern/);
	});

	it("path + quietForSeconds is a silence watch (the live-extras regression)", () => {
		const res = buildTrigger({ path: "/tmp/x", quietForSeconds: 60 });
		assert.deepEqual(res.trigger, { kind: "file-quiet", path: "/tmp/x", seconds: 60 });
		const fast = buildTrigger({ path: "/tmp/x", quietForSeconds: 5 });
		assert.match((fast as { error: string }).error, /quietForSeconds must be >= 60/);
	});

	it("pid alongside a condition is a death guard — nothing is silently dropped", () => {
		const a = buildTrigger({ pid: 42, path: "/tmp/x", pattern: "DONE" });
		assert.deepEqual(a.trigger, { kind: "file-contains", path: "/tmp/x", pattern: "DONE" });
		assert.equal(a.guardPid, 42);
		const b = buildTrigger({ pid: 42, path: "/tmp/x", quietForSeconds: 60 });
		assert.equal(b.trigger?.kind, "file-quiet");
		assert.equal(b.guardPid, 42);
		const c = buildTrigger({ pid: 42, deadlineSeconds: 5 });
		assert.equal(c.trigger?.kind, "deadline");
		assert.equal(c.guardPid, 42);
		const d = buildTrigger({ pid: 42 }); // alone: the condition IS the exit
		assert.deepEqual(d.trigger, { kind: "pid-exit", pid: 42 });
		assert.equal(d.guardPid, undefined);
	});

	it("rejects catastrophically-backtracking patterns at register time", () => {
		const bad = buildTrigger({ path: "/tmp/x", pattern: "(a+)+b" });
		assert.match((bad as { error: string }).error, /backtracking/);
		const good = buildTrigger({ path: "/tmp/x", pattern: "^ok now$" });
		assert.ok("trigger" in (good as object) && (good as { trigger?: unknown }).trigger);
	});

	it("allows heartbeat-only watches", () => {
		assert.deepEqual(buildTrigger({ heartbeatSeconds: 30 }), {});
	});
});

describe("describePidSurvival", () => {
	it("flags a process in the host's session as kill-scope, with a remedy notice", async () => {
		// A plain (non-setsid) child shares our session.
		const child = spawn("sleep", ["5"], { stdio: "ignore" });
		try {
			const survival = describePidSurvival(child.pid!);
			assert.equal(survival.alive, true);
			assert.equal(survival.detached, false);
			assert.match(survival.verdict, /killed when pi exits/);
			assert.match(survival.notice!, /job_watch run/);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("recognizes a session leader as detached (survives pi)", async () => {
		// spawn(detached) does setsid: the child leads its own session.
		const child = spawn("sleep", ["5"], { stdio: "ignore", detached: true });
		try {
			const survival = describePidSurvival(child.pid!);
			assert.equal(survival.alive, true);
			assert.equal(survival.detached, true);
			assert.match(survival.verdict, /survives pi exiting/);
			assert.equal(survival.notice, undefined);
		} finally {
			process.kill(-child.pid!, "SIGKILL");
		}
	});

	it("reports dead pids as gone", () => {
		const survival = describePidSurvival(999_999_999);
		assert.equal(survival.alive, false);
		assert.match(survival.verdict, /gone/);
	});
});

describe("registerJobWatchTool (one surface, two scopes)", () => {
	function fakePi() {
		let registered: { name: string; execute: (...args: any[]) => Promise<any> } | undefined;
		return {
			registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
				registered = tool;
			},
			get tool() {
				assert.ok(registered, "tool registered");
				return registered!;
			},
		};
	}

	function fakeApi(overrides: Partial<JobWatchApi> = {}) {
		const calls: Array<{ method: string; arg?: unknown }> = [];
		const notices: string[] = [];
		const api: JobWatchApi = {
			register: (input) => {
				calls.push({ method: "register", arg: input });
				return { ok: true, id: "w-1" };
			},
			attach: (o) => {
				calls.push({ method: "attach", arg: o });
				return { ok: true, id: "w-1", pid: o.pid, survival: "✓ own session — survives pi exiting" };
			},
			run: async (o) => {
				calls.push({ method: "run", arg: o });
				return { ok: true, id: "w-1", pid: 123, logPath: "/tmp/l" };
			},
			list: () => [] as WatchView[],
			tail: () => "tail",
			cancel: () => ({ ok: true, reason: "cancelled w-1" }),
			extend: () => ({ ok: true, reason: "extended w-1" }),
			notifyParent: (t) => notices.push(t),
			...overrides,
		};
		return { api, calls, notices };
	}

	const ctx = { cwd: "/tmp" } as any;

	it("exposes the identical tool name and routes each action to the api", async () => {
		const pi = fakePi();
		const { api, calls } = fakeApi();
		registerJobWatchTool(pi as any, api);
		assert.equal(pi.tool.name, JOB_WATCH_TOOL_NAME);

		await pi.tool.execute("t1", { pid: 42, label: "job" }, undefined, undefined, ctx);
		assert.deepEqual(calls[0], { method: "attach", arg: { pid: 42, label: "job" } });

		await pi.tool.execute("t2", { action: "attach", pid: 7 }, undefined, undefined, ctx);
		assert.equal(calls[1]!.method, "attach");

		await pi.tool.execute("t3", { action: "run", command: "sleep 1" }, undefined, undefined, ctx);
		assert.equal(calls[2]!.method, "run");

		await pi.tool.execute("t4", { action: "register", path: "/tmp/f", pattern: "DONE" }, undefined, undefined, ctx);
		assert.equal(calls[3]!.method, "register");
	});

	it("pushes kill-scope notices to the deciding model (notifyParent)", async () => {
		const pi = fakePi();
		const { api, notices } = fakeApi({
			attach: (o) => ({
				ok: true,
				id: "w-2",
				pid: o.pid,
				notice: "⚠ job_watch: pid 5 shares pi's session — it WILL die when pi exits or the turn aborts. Remedy: relaunch it detached (job_watch run, or setsid … &), then attach to that.",
			}),
		});
		registerJobWatchTool(pi as any, api);
		const res = await pi.tool.execute("t1", { action: "attach", pid: 5 }, undefined, undefined, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /Remedy: relaunch/);
		assert.match((res.content[0] as { text: string }).text, /⚠ job_watch: pid 5/);
	});

	it("formats failure reasons without creating anything", async () => {
		const pi = fakePi();
		const seen: string[] = [];
		const { api } = fakeApi({
			register: () => {
				seen.push("register");
				return { ok: false, reason: "boom" };
			},
		});
		registerJobWatchTool(pi as any, api);
		const res = await pi.tool.execute("t1", { action: "register", path: "/tmp/f", pattern: "x" }, undefined, undefined, ctx);
		assert.match((res.content[0] as { text: string }).text, /boom/);
		assert.deepEqual(seen, ["register"], "only the api call happened");
	});

	it("survival verdicts ride list output", () => {
		const text = formatWatchViews([
			{ id: "w-1", state: "pending", label: "x", survival: "⚠ in pi's session — will be killed when pi exits or aborts", heartbeatMs: 30_000 },
		]);
		assert.match(text, /w-1 \[pending\]/);
		assert.match(text, /⚠ in pi's session/);
		assert.match(text, /heartbeat 30s/);
	});
});