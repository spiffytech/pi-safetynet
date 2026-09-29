import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SubagentJobManager,
	MAX_LIVE_JOBS,
	REPORT_DEBOUNCE_MS,
	REPORT_RETRY_MS,
} from "./subagent-jobs.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager(overrides: { compacting?: boolean } = {}) {
	const sent: Array<{ text: string; urgent: boolean; jobId: string }> = [];
	const manager = new SubagentJobManager({
		sendToParent: (text, opts) => sent.push({ text, urgent: opts.urgent, jobId: opts.jobId }),
		isCompacting: () => overrides.compacting ?? false,
	});
	return { manager, sent };
}

describe("SubagentJobManager", () => {
	it("caps live jobs at MAX_LIVE_JOBS and names open jobs on refusal", () => {
		const { manager } = makeManager();
		for (let i = 0; i < MAX_LIVE_JOBS; i++) manager.create({ prompt: "x", cwd: "/tmp", spawnMode: "ro" });
		assert.throws(
			() => manager.create({ prompt: "x", cwd: "/tmp", spawnMode: "ro" }),
			/Too many live subagents/,
		);
	});

	it("moves starting -> running -> idle and records segment reporting", () => {
		const { manager } = makeManager();
		const job = manager.create({ prompt: "task", cwd: "/tmp", spawnMode: "rw" });
		assert.equal(job.state, "starting");
		manager.setControls(job.id, { prompt: async () => {}, steer: async () => {}, abort: () => {} });
		assert.equal(manager.get(job.id)!.state, "running");
		manager.submitReport(job.id, { summary: "progress" });
		assert.equal(manager.status(job.id)!.reported, true);
		manager.beginSegment(job.id);
		assert.equal(manager.status(job.id)!.reported, false);
		manager.idle(job.id);
		assert.equal(manager.get(job.id)!.state, "idle");
	});

	it("leading-edge debounce: first report now, rest coalesced", async () => {
		const { manager, sent } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "one" });
		assert.equal(sent.length, 1, "first report delivered immediately");
		manager.submitReport(job.id, { summary: "two" });
		manager.submitReport(job.id, { summary: "three" });
		assert.equal(sent.length, 1, "subsequent reports within the window are held");
		await delay(REPORT_DEBOUNCE_MS + 80);
		assert.equal(sent.length, 2);
		assert.match(sent[1]!.text, /two/);
		assert.match(sent[1]!.text, /three/);
	});

	it("urgent reports wake immediately", () => {
		const { manager, sent } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "blocked", urgent: true });
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.urgent, true);
	});

	it("delivers accumulated usage exactly once", () => {
		const { manager } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.addUsage(job.id, {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		});
		const first = manager.deliverUsage(job);
		assert.equal(first!.input, 10);
		assert.equal(manager.deliverUsage(job), undefined);
	});

	it("kills jobs spawned under a different mode", () => {
		const { manager } = makeManager();
		const ro = manager.create({ prompt: "a", cwd: "/tmp", spawnMode: "ro" });
		const rw = manager.create({ prompt: "b", cwd: "/tmp", spawnMode: "rw" });
		manager.killByMode("rw");
		assert.equal(manager.get(ro.id), undefined);
		assert.equal(manager.get(rw.id)!.closed, false);
	});

	it("close clears any pending wake for that job", async () => {
		const { manager, sent } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.idle(job.id);
		manager.close(job.id);
		await delay(REPORT_DEBOUNCE_MS + 80);
		assert.equal(sent.length, 0);
	});

	it("defers delivery while the parent is compacting, then drains", () => {
		let compacting = true;
		const sent: string[] = [];
		const manager = new SubagentJobManager({
			sendToParent: (text) => sent.push(text),
			isCompacting: () => compacting,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "held" });
		assert.equal(sent.length, 0);
		compacting = false;
		manager.drain();
		assert.equal(sent.length, 1);
		assert.match(sent[0]!, /held/);
	});

	it("wake text carries no job identity (pull trigger, not a payload)", async () => {
		const { manager, sent } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.idle(job.id);
		await delay(REPORT_DEBOUNCE_MS + 80);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!.text, /subagent_status/);
		assert.doesNotMatch(sent[0]!.text, /sub-1/);
	});

	it("defers wakes while the parent is mid-turn, then drains at the boundary", async () => {
		let busy = true;
		const sent: string[] = [];
		const manager = new SubagentJobManager({
			sendToParent: (text) => sent.push(text),
			isCompacting: () => false,
			isParentBusy: () => busy,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.idle(job.id);
		await delay(REPORT_DEBOUNCE_MS + 80);
		assert.equal(sent.length, 0, "no wake while the parent is mid-turn");
		busy = false;
		manager.drain();
		assert.equal(sent.length, 1);
	});

	it("a job closed while the parent was mid-turn produces no wake", async () => {
		let busy = true;
		const sent: string[] = [];
		const manager = new SubagentJobManager({
			sendToParent: (text) => sent.push(text),
			isCompacting: () => false,
			isParentBusy: () => busy,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.idle(job.id);
		await delay(REPORT_DEBOUNCE_MS + 80);
		manager.close(job.id);
		busy = false;
		manager.drain();
		assert.equal(sent.length, 0, "the closed job is filtered at the boundary");
	});

	it("does not count a failed job against the live cap", () => {
		const { manager } = makeManager();
		const jobs = [];
		for (let i = 0; i < MAX_LIVE_JOBS; i++) jobs.push(manager.create({ prompt: "x", cwd: "/tmp", spawnMode: "ro" }));
		manager.fail(jobs[0]!.id, "boom");
		assert.equal(manager.liveCount(), MAX_LIVE_JOBS - 1);
		assert.doesNotThrow(() => manager.create({ prompt: "x", cwd: "/tmp", spawnMode: "ro" }));
	});

	it("delivers an urgent report urgently after a compaction deferral", () => {
		let compacting = true;
		const sent: Array<{ text: string; urgent: boolean }> = [];
		const manager = new SubagentJobManager({
			sendToParent: (text, opts) => sent.push({ text, urgent: opts.urgent }),
			isCompacting: () => compacting,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "urgent", urgent: true });
		assert.equal(sent.length, 0, "deferred while compacting");
		compacting = false;
		manager.drain();
		assert.equal(sent.length, 1);
		assert.equal(sent[0]!.urgent, true, "urgency is preserved across the deferral");
	});

	it("close flushes an undelivered report instead of dropping it", async () => {
		const { manager, sent } = makeManager();
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "first" });
		manager.submitReport(job.id, { summary: "second" });
		manager.close(job.id);
		await delay(REPORT_DEBOUNCE_MS + 80);
		assert.equal(sent.length, 2, "the still-debounced report is flushed, not dropped");
		assert.match(sent[1]!.text, /second/);
	});

	it("takeUndeliveredReports pulls and marks reports delivered, with no double push", () => {
		let compacting = true;
		const sent: string[] = [];
		const manager = new SubagentJobManager({
			sendToParent: (text) => sent.push(text),
			isCompacting: () => compacting,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "one", body: "body-one" });
		const taken = manager.takeUndeliveredReports(job.id);
		assert.equal(taken.length, 1);
		assert.equal(taken[0]!.summary, "one");
		assert.equal(manager.takeUndeliveredReports(job.id).length, 0, "second pull is empty");
		compacting = false;
		manager.drain();
		assert.equal(sent.length, 0, "a pulled report is not also pushed");
	});

	it("retries a transient send failure without waiting for an event", async () => {
		let fail = true;
		const sent: string[] = [];
		const manager = new SubagentJobManager({
			sendToParent: (text) => {
				if (fail) throw new Error("boom");
				sent.push(text);
			},
			isCompacting: () => false,
		});
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.submitReport(job.id, { summary: "retry-me" });
		assert.equal(sent.length, 0, "the leading send threw");
		fail = false;
		await delay(REPORT_RETRY_MS + 250);
		assert.equal(sent.length, 1);
		assert.match(sent[0]!, /retry-me/);
	});

	it("resetForSession clears jobs, timers, and disposed state", () => {
		const { manager } = makeManager();
		manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		manager.dispose();
		assert.equal(manager.isDisposed(), true);
		assert.equal(manager.liveCount(), 0);
		manager.resetForSession();
		assert.equal(manager.isDisposed(), false);
		const job = manager.create({ prompt: "t", cwd: "/tmp", spawnMode: "ro" });
		// The id counter is not reset: a recycled id could collide with a
		// still-settling callback from a just-disposed child session.
		assert.equal(job.id, "sub-2");
	});
});
