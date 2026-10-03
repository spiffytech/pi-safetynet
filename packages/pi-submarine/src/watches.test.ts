import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchManager, watchStorePath, WATCH_EXIT_MARKER, type WatchManagerOptions } from "./watches.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await delay(10);
	}
	return cond();
}

interface Harness {
	manager: WatchManager;
	events: Array<{ text: string; urgent: boolean }>;
	resumes: Array<{ jobId: string; text: string }>;
	dir: string;
	storePath: string;
	setDeliverable(v: boolean): void;
}

function makeHarness(overrides: Partial<WatchManagerOptions> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-watches-"));
	const events: Harness["events"] = [];
	const resumes: Harness["resumes"] = [];
	let deliverable = true;
	const storePath = watchStorePath(join(dir, "agent"), join(dir, "cwd"));
	const manager = new WatchManager({
		storePath,
		cwd: join(dir, "cwd"),
		minHeartbeatMs: 10,
		pollIntervalMs: 10,
		maxLifetimeMs: 60_000,
		sendParentEvent: (text, urgent) => events.push({ text, urgent }),
		resumeChild: (jobId, text) => {
			resumes.push({ jobId, text });
			return true;
		},
		canDeliver: () => deliverable,
		...overrides,
	});
	return {
		manager,
		events,
		resumes,
		dir,
		storePath,
		setDeliverable: (v) => {
			deliverable = v;
		},
	};
}

describe("WatchManager", () => {
	it("fires on file-contains with a preview of the last log line", async () => {
		const h = makeHarness();
		const log = join(h.dir, "copy.log");
		writeFileSync(log, "progress 1%\nprogress 2%\n");
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "DONE" },
			logPath: log,
			label: "copy",
		});
		assert.equal(res.ok, true);
		assert.equal(h.events.length, 0, "no event before the condition holds");
		appendFileSync(log, "all files copied DONE\n");
		assert.ok(await waitFor(() => h.events.length > 0), "event delivered");
		assert.equal(h.events[0]!.urgent, true);
		assert.match(h.events[0]!.text, /pattern 'DONE' found/);
		assert.match(h.events[0]!.text, /last: all files copied DONE/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("heartbeats on cadence and stops after cancel", async () => {
		const h = makeHarness();
		const log = join(h.dir, "hb.log");
		writeFileSync(log, "tick-one\n");
		const res = h.manager.register({ kind: "parent" }, {
			heartbeatMs: 20,
			logPath: log,
			label: "hb",
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		assert.ok(await waitFor(() => h.events.length >= 2), "two heartbeats arrived");
		assert.match(h.events[0]!.text, /heartbeat at /);
		assert.match(h.events[0]!.text, /last: tick-one/);
		const c = h.manager.cancel(res.id);
		assert.equal(c.ok, true);
		await delay(80);
		const count = h.events.length;
		await delay(80);
		assert.equal(h.events.length, count, "no heartbeats after cancel");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("fires on pid-exit and reports the exit artifact when the log has one", async () => {
		const h = makeHarness();
		const log = join(h.dir, "job.log");
		writeFileSync(log, `some output\n${WATCH_EXIT_MARKER}0\n`);
		const child = spawn("bash", ["-c", "sleep 0.05"]);
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "pid-exit", pid: child.pid! },
			logPath: log,
			label: "job",
		});
		assert.ok(await waitFor(() => h.events.length > 0), "pid-exit event delivered");
		assert.match(h.events[0]!.text, /pid \d+ exited/);
		assert.match(h.events[0]!.text, /exit artifact present: exit 0/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("fires on deadline", async () => {
		const h = makeHarness();
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60 },
			label: "deadline",
		});
		assert.ok(await waitFor(() => h.events.length > 0), "deadline event delivered");
		assert.match(h.events[0]!.text, /deadline .* passed/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("rejects heartbeats below the minimum and triggerless watches", () => {
		const h = makeHarness({ minHeartbeatMs: 50 });
		const tooFast = h.manager.register({ kind: "parent" }, { heartbeatMs: 10 });
		assert.equal(tooFast.ok, false);
		const empty = h.manager.register({ kind: "parent" }, {});
		assert.equal(empty.ok, false);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("expires watches at the lifetime cap", async () => {
		const h = makeHarness({ maxLifetimeMs: 60 });
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "forever",
		});
		assert.ok(await waitFor(() => h.events.length > 0), "expiry event delivered");
		assert.match(h.events[0]!.text, /expired \(lifetime cap\)/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("defers parent events while undeliverable and flushes at the boundary", async () => {
		const h = makeHarness();
		h.setDeliverable(false);
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 30 },
			label: "deferred",
		});
		assert.ok(await waitFor(() => h.events.length === 0), "no delivery while parent is busy");
		await delay(80); // deadline passes while undeliverable
		assert.equal(h.events.length, 0, "still held");
		h.setDeliverable(true);
		h.manager.flushEvents();
		assert.equal(h.events.length, 1, "delivered at the turn boundary");
		assert.match(h.events[0]!.text, /fired at /);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("resumes the owning child on fire, and falls back to the parent when the job is gone", async () => {
		const live = makeHarness();
		live.manager.register({ kind: "child", jobId: "sub-1" }, {
			trigger: { kind: "deadline", at: Date.now() + 30 },
			label: "child-owned",
		});
		assert.ok(await waitFor(() => live.resumes.length > 0), "child resumed");
		assert.equal(live.resumes[0]!.jobId, "sub-1");
		assert.equal(live.events.length, 0, "parent hears nothing when the child is alive");

		const gone = makeHarness({
			resumeChild: () => false,
		});
		gone.manager.register({ kind: "child", jobId: "sub-1" }, {
			trigger: { kind: "deadline", at: Date.now() + 30 },
			label: "orphaned",
		});
		assert.ok(await waitFor(() => gone.events.length > 0), "parent hears for a dead job");
		assert.match(gone.events[0]!.text, /owner job sub-1 is gone/);
		live.manager.dispose();
		gone.manager.dispose();
		rmSync(live.dir, { recursive: true, force: true });
		rmSync(gone.dir, { recursive: true, force: true });
	});

	it("isolates cancellation: a child cannot cancel another owner's watch", () => {
		const h = makeHarness();
		const res = h.manager.register({ kind: "child", jobId: "sub-1" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const wrong = h.manager.cancel(res.id, { kind: "child", jobId: "sub-2" });
		assert.equal(wrong.ok, false);
		const right = h.manager.cancel(res.id, { kind: "child", jobId: "sub-1" });
		assert.equal(right.ok, true);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("cancels every watch owned by a job at once", () => {
		const h = makeHarness();
		h.manager.register({ kind: "child", jobId: "sub-1" }, { heartbeatMs: 60_000 });
		h.manager.register({ kind: "child", jobId: "sub-1" }, { trigger: { kind: "deadline", at: Date.now() + 60_000 } });
		h.manager.register({ kind: "child", jobId: "sub-2" }, { trigger: { kind: "deadline", at: Date.now() + 60_000 } });
		assert.equal(h.manager.hasPendingForChild("sub-1"), true);
		const n = h.manager.cancelOwnedBy("sub-1");
		assert.equal(n, 2);
		assert.equal(h.manager.hasPendingForChild("sub-1"), false);
		assert.equal(h.manager.hasPendingForChild("sub-2"), true);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("survives a simulated pi restart: missed events fire with a down-time verdict", async () => {
		const h = makeHarness();
		const log = join(h.dir, "restart.log");
		writeFileSync(log, "working\n");
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "DONE" },
			logPath: log,
			label: "restart",
		});
		assert.equal(res.ok, true);
		h.manager.dispose(); // pi dies: waiters go, records persist

		appendFileSync(log, "finished DONE\n"); // the job completed while pi was down

		const h2 = makeHarness({ storePath: h.storePath, cwd: join(h.dir, "cwd") });
		// makeHarness mkdtemps a fresh dir; point it at the first store explicitly.
		h2.manager.reattachPending();
		assert.equal(h2.events.length, 0, "adoption events are held until a turn boundary");
		h2.manager.flushEvents(); // the first agent_end
		assert.ok(await waitFor(() => h2.events.length > 0), "missed event fires at reattach");
		assert.match(h2.events[0]!.text, /fired while pi was down/);
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
	});

	it("inherits restart-orphaned child watches into the parent", async () => {
		const h = makeHarness({ isChildLive: () => true });
		h.manager.register({ kind: "child", jobId: "sub-7" }, {
			trigger: { kind: "deadline", at: Date.now() + 10_000 },
			label: "child monitor",
		});
		h.manager.dispose(); // pi dies mid-monitoring

		const h2 = makeHarness({
			storePath: h.storePath,
			cwd: join(h.dir, "cwd"),
			isChildLive: () => false, // jobs are in-memory: sub-7 is gone
		});
		h2.manager.reattachPending();
		assert.equal(h2.manager.list({ kind: "parent" }).length, 1, "record inherited by parent");
		assert.equal(h2.manager.hasPendingForChild("sub-7"), false);
		await delay(50);
		assert.equal(h2.resumes.length, 0, "no resume attempts for the dead job");
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
	});

	it("persists records across managers (restart does not lose a watch)", () => {
		const h = makeHarness();
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "durable",
		});
		assert.equal(res.ok, true);
		h.manager.dispose();
		const raw = readFileSync(h.storePath, "utf-8");
		assert.match(raw, /durable/);
		const h2 = makeHarness({ storePath: h.storePath, cwd: join(h.dir, "cwd") });
		assert.equal(h2.manager.list().length, 1);
		assert.equal(h2.manager.list()[0]!.state, "pending");
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
	});
});