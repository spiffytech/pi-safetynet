import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchManager, watchStorePath, WATCH_EXIT_MARKER, IncrementalMatcher, OVERLAP_BYTES, formatWatchChip } from "./watches.ts";
import type { WatchManagerOptions } from "./watches.ts";

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
		defaultLifetimeMs: 60_000,
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

describe("file-contains matching (regex, overlap re-scan)", () => {
	it("matches a pattern split across two reads — the re-scan fix", async () => {
		const h = makeHarness();
		const log = join(h.dir, "split.log");
		writeFileSync(log, "start\n");
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "DONE" },
			logPath: log,
		});
		appendFileSync(log, "DO"); // first half flushes alone
		await delay(80); // several polls pass over the partial bytes
		assert.equal(h.events.length, 0, "no premature match on the half pattern");
		appendFileSync(log, "NE all good\n"); // second half completes it
		assert.ok(await waitFor(() => h.events.length > 0), "match found once the bytes land");
		assert.match(h.events[0]!.text, /pattern 'DONE' found/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("matches an unterminated final line (no trailing newline yet)", async () => {
		const h = makeHarness();
		const log = join(h.dir, "partial.log");
		writeFileSync(log, "");
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "xfr#1" },
			logPath: log,
		});
		appendFileSync(log, "xfr#1  22%"); // rsync-style, no newline
		assert.ok(await waitFor(() => h.events.length > 0), "matches the live tail");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("^…$ anchors match exactly one line (m-flagged regex)", async () => {
		const h = makeHarness();
		const log = join(h.dir, "lines.log");
		writeFileSync(log, "FINISHEDISH\n");
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "^FINISHED$" },
			logPath: log,
		});
		await delay(80);
		assert.equal(h.events.length, 0, "near-miss line does not fire");
		appendFileSync(log, "FINISHED\n");
		assert.ok(await waitFor(() => h.events.length > 0), "exact line fires");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("supports real regex syntax and rejects invalid patterns at register", async () => {
		const h = makeHarness();
		const log = join(h.dir, "re.log");
		writeFileSync(log, "exit code: 3\n");
		const bad = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "([unclosed" },
		});
		assert.equal(bad.ok, false);
		assert.match((bad as { reason: string }).reason, /invalid pattern regex/);
		const good = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "^exit code: [0-9]+$" },
			logPath: log,
		});
		assert.equal(good.ok, true);
		assert.ok(await waitFor(() => h.events.length > 0), "character-class regex fires");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});
});

describe("IncrementalMatcher (property: arbitrary chunk splits)", () => {
	function makeRng(seed: number) {
		let s = seed >>> 0;
		return (n: number) => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s % n;
		};
	}

	const PATTERNS = ["DONE", "^FINISHED$", "exit code: [0-9]+", "é", "©日", "a\\s+b", "xfr#\\d+"];

	it("random texts × random byte splits: incremental == one-shot over prefixes", () => {
		const rand = makeRng(20261002);
		const alphabet = ["a", "b", " ", "\n", "\r", "DONE", "FINISHED", "exit code: 7", "é", "©", "日", "xfr#2", "a b"];
		for (let iter = 0; iter < 300; iter++) {
			let text = "";
			const parts = 1 + rand(30);
			for (let p = 0; p < parts; p++) text += alphabet[rand(alphabet.length)]!;
			const pattern = PATTERNS[rand(PATTERNS.length)]!;
			const re = new RegExp(pattern, "m");
			const bytes = Buffer.from(text, "utf-8");
			const cuts = [0, bytes.length];
			const nCuts = 1 + rand(4);
			for (let c = 0; c < nCuts; c++) cuts.push(rand(bytes.length + 1));
			cuts.sort((a, b) => a - b);
			const m = new IncrementalMatcher(pattern);
			let incremental = false;
			let seen = Buffer.alloc(0);
			const prefixMatch: boolean[] = [];
			for (let c = 0; c < cuts.length - 1; c++) {
				const chunk = bytes.subarray(cuts[c]!, cuts[c + 1]!);
				if (chunk.length === 0) continue;
				if (m.feed(chunk).hit) incremental = true;
				seen = Buffer.concat([seen, chunk]);
				prefixMatch.push(re.test(seen.toString("utf-8")));
			}
			const oneShot = prefixMatch.some(Boolean);
			assert.equal(
				incremental,
				oneShot,
				`pattern=${pattern} text=${JSON.stringify(text)} cuts=${cuts.join(",")}`,
			);
			if (re.test(text)) {
				assert.equal(incremental, true, "completeness: a full-text match must be caught across ANY split");
			}
		}
	});

	it("exhaustive: one split at EVERY byte boundary changes nothing", () => {
		const text = "pré-DONE-©\nFINISHED\nexit code: 7\n";
		for (const pattern of ["DONE", "^FINISHED$", "é", "é-DONE", "^exit code: [0-9]+$"]) {
			const re = new RegExp(pattern, "m");
			const bytes = Buffer.from(text, "utf-8");
			const full = re.test(text);
			for (let cut = 0; cut <= bytes.length; cut++) {
				const m = new IncrementalMatcher(pattern);
				let hit = false;
				if (cut > 0) hit = m.feed(bytes.subarray(0, cut)).hit;
				if (cut < bytes.length) hit = m.feed(bytes.subarray(cut)).hit || hit;
				const prefixHit = cut > 0 ? re.test(bytes.subarray(0, cut).toString("utf-8")) : false;
				assert.equal(hit, full || prefixHit, `pattern=${pattern} cut=${cut}`);
			}
		}
	});

	it("a multibyte character split across feeds still matches", () => {
		const m = new IncrementalMatcher("é");
		const bytes = Buffer.from("xéy", "utf-8"); // x | C3 A9 | y
		assert.equal(m.feed(bytes.subarray(0, 2)).hit, false, "lead byte alone is not a miss — it is held");
		assert.equal(m.feed(bytes.subarray(2, 3)).hit, true, "trail byte completes the character");
	});

	it("window bounds long tails without losing recent matches", () => {
		const m = new IncrementalMatcher("NEEDLE");
		const filler = "x".repeat(OVERLAP_BYTES * 2);
		assert.equal(m.feed(Buffer.from(filler + "NEEDLE", "utf-8")).hit, true);
		const m2 = new IncrementalMatcher("^line-early$|^line-late$");
		assert.equal(m2.feed(Buffer.from("line-early\n", "utf-8")).hit, true);
	});
});

describe("reboot & pid-reuse identity", () => {
	it("detects a machine reboot across a restart via the boot id", async () => {
		const h = makeHarness({
			procIdentity: { bootId: () => "boot-A", startTicks: () => 123, alive: () => true },
		});
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "pid-exit", pid: 4242 },
			label: "rebooted-job",
		});
		h.manager.dispose();
		// Machine reboots: same pid space, new boot id, old pid gone.
		const h2 = makeHarness({
			storePath: h.storePath,
			cwd: join(h.dir, "cwd"),
			procIdentity: { bootId: () => "boot-B", startTicks: () => undefined, alive: () => false },
		});
		h2.manager.reattachPending();
		h2.manager.flushEvents();
		assert.equal(h2.events.length, 1);
		assert.match(h2.events[0]!.text, /machine rebooted while we were away; pid 4242 is gone/);
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
	});

	it("detects pid reuse while running: same pid, different process", async () => {
		let ticks = 100;
		const h = makeHarness({
			pollIntervalMs: 10,
			procIdentity: { bootId: () => "boot-A", startTicks: () => ticks, alive: () => true },
		});
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "pid-exit", pid: 777 },
			label: "oom-prone",
		});
		await delay(50);
		assert.equal(h.events.length, 0, "same identity: still considered alive");
		ticks = 999; // kernel recycled the pid onto a different process
		assert.ok(await waitFor(() => h.events.length > 0), "reuse is recognized as death");
		assert.match(h.events[0]!.text, /pid 777 was reused by an unrelated process/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("without /proc identity, a live pid waits — never a false 'exited'", async () => {
		const h = makeHarness({
			pollIntervalMs: 10,
			procIdentity: { bootId: () => undefined, startTicks: () => undefined, alive: () => true },
		});
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "pid-exit", pid: 555 },
			label: "mac-shape",
		});
		await delay(80);
		assert.equal(h.events.length, 0, "alive-but-unidentifiable must not be reported as dead");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("a plain death without reboot keeps the plain verdict (OOM shape)", async () => {
		const h = makeHarness({
			pollIntervalMs: 10,
			procIdentity: { bootId: () => "boot-A", startTicks: (pid) => (pid === 888 ? undefined : 1), alive: (pid) => pid !== 888 },
		});
		const log = join(h.dir, "killed.log");
		writeFileSync(log, "started\n"); // job died mid-flight: no exit marker written
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "pid-exit", pid: 888 },
			logPath: log,
			label: "killed-job",
		});
		assert.ok(await waitFor(() => h.events.length > 0), "death detected");
		assert.match(h.events[0]!.text, /pid 888 exited/);
		assert.match(h.events[0]!.text, /no exit artifact/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});
});

describe("formatWatchChip (the human's footer view)", () => {
	const view = (over: Partial<import("pi-submarine-core").WatchView>): import("pi-submarine-core").WatchView => ({
		id: "w-1",
		state: "pending",
		label: "pid 777 exits",
		owner: { kind: "parent" },
		createdAt: 0,
		expiresAt: 0,
		...over,
	});

	it("is silent when nothing is being waited on", () => {
		assert.equal(formatWatchChip([]), undefined);
		assert.equal(formatWatchChip([view({ state: "fired" })]), undefined);
	});

	it("shows what is waited on and who holds it", () => {
		const chip = formatWatchChip([
			view({}),
			view({ id: "w-2", label: "a-very-long-label-that-just-keeps-going-on-forever", claimedBy: 200 }),
		]);
		assert.ok(chip);
		assert.match(chip, /⏱ 2 waiting/);
		assert.match(chip, /w-1: pid 777 exits/);
		assert.match(chip, /w-2@s200:/);
		assert.match(chip, /…/);
	});

	it("caps the list at three with a +N", () => {
		const chip = formatWatchChip([view({ id: "w-1" }), view({ id: "w-2" }), view({ id: "w-3" }), view({ id: "w-4" })]);
		assert.ok(chip);
		assert.match(chip, /\+1$/);
		assert.doesNotMatch(chip, /w-4/);
	});
});

describe("death guard — death is never silent", () => {
	it("a guarded death fires the watch even when its condition never happens", async () => {
		let ticks = 100;
		const h = makeHarness({
			pollIntervalMs: 10,
			procIdentity: {
				bootId: () => "boot-A",
				startTicks: () => (ticks === 0 ? undefined : ticks),
				alive: () => ticks !== 0,
			},
		});
		const log = join(h.dir, "guard.log");
		writeFileSync(log, "working\n");
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "^NEVER$" },
			guardPid: 777,
			label: "guarded",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		await delay(60);
		assert.equal(h.events.length, 0, "pattern unmatched and the pid lives");
		ticks = 0; // the guarded job dies without ever writing the pattern
		assert.ok(await waitFor(() => h.events.length > 0), "death fires the watch");
		assert.match(h.events[0]!.text, /guard: pid 777 exited/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("the condition wins the race — the guard is a backstop, not a hijack", async () => {
		const h = makeHarness();
		const log = join(h.dir, "race.log");
		writeFileSync(log, "working\n");
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-contains", path: log, pattern: "^FINISHED$" },
			guardPid: 777,
			lifetimeMinutes: 5,
		});
		appendFileSync(log, "FINISHED\n");
		assert.ok(await waitFor(() => h.events.length > 0), "condition fires");
		assert.match(h.events[0]!.text, /pattern '\^FINISHED\$' found/);
		assert.doesNotMatch(h.events[0]!.text, /guard:/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("guard death while pi was down surfaces at reattach", async () => {
		const h = makeHarness({
			procIdentity: { bootId: () => "boot-A", startTicks: () => 1, alive: () => true },
		});
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			guardPid: 999,
			label: "guarded-down",
			lifetimeMinutes: 5,
		});
		h.manager.dispose();
		const h2 = makeHarness({
			storePath: h.storePath,
			cwd: join(h.dir, "cwd"),
			procIdentity: { bootId: () => "boot-A", startTicks: () => undefined, alive: () => false },
		});
		h2.manager.reattachPending();
		h2.manager.flushEvents();
		assert.ok(
			await waitFor(() => h2.events.some((e) => /fired while pi was down: guard: pid 999 exited/.test(e.text)), 2000),
			"the guarded death is reported at adoption",
		);
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
	});
});

// ─── WatchManager ───

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

	it("warns once near expiry, then expires — and extend is a stay of execution", async () => {
		const h = makeHarness({ defaultLifetimeMs: 150 });
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "forever",
		});
		assert.ok(await waitFor(() => h.events.length > 0), "pre-expiry warning delivered");
		assert.match(h.events[0]!.text, /expires in/);
		assert.match(h.events[0]!.text, /job_watch extend/);
		assert.ok(
			await waitFor(() => h.events.some((e) => /expired \(lifetime cap\)/.test(e.text)), 2000),
			"expiry event delivered",
		);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("extend pushes expiry out and re-arms the warning", async () => {
		const h = makeHarness({ defaultLifetimeMs: 120 });
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "extendable",
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const ext = h.manager.extend(res.id, 10);
		assert.equal(ext.ok, true);
		assert.match(ext.reason, /extended w-[\w-]+ by 10min/);
		await delay(200); // past the original 120ms lifetime
		assert.equal(h.events.length, 0, "neither warning nor expiry after extension");
		const ownerBlocked = h.manager.extend(res.id, 10, { kind: "child", jobId: "someone-else" });
		assert.equal(ownerBlocked.ok, false);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("file-quiet fires only after the silence floor elapses", async () => {
		const h = makeHarness();
		const log = join(h.dir, "quiet.log");
		writeFileSync(log, "working\n");
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-quiet", path: log, seconds: 60 },
			label: "quiet-watch",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		const tooFast = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "file-quiet", path: log, seconds: 5 },
		});
		assert.equal(tooFast.ok, false, "silence floor is 60s");
		// Growth resets the clock: keep writing, expect no fire.
		for (let i = 0; i < 3; i++) {
			appendFileSync(log, `line ${i}\n`);
			await delay(30);
		}
		assert.equal(h.events.length, 0, "output is not silence");
		// Fake the clock forward past the floor with no growth.
		const h2 = makeHarness({
			storePath: h.storePath,
			cwd: join(h.dir, "cwd"),
			now: () => Date.now() + 61_000,
		});
		h.manager.dispose();
		h2.manager.reattachPending();
		h2.manager.flushEvents();
		assert.ok(
			await waitFor(() => h2.events.some((e) => /no new output in .* for \d+s/.test(e.text)), 2000),
			"silence fired after reattach",
		);
		h2.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(h2.dir, { recursive: true, force: true });
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

	it("announces re-armed pending watches at reattach — nothing dropped silently", async () => {
		const h = makeHarness();
		h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "still-waiting",
		});
		h.manager.dispose(); // pi dies with the watch still pending
		const h2 = makeHarness({ storePath: h.storePath, cwd: join(h.dir, "cwd") });
		h2.manager.reattachPending();
		h2.manager.flushEvents();
		assert.equal(h2.events.length, 1, "the model is told its watch survived");
		assert.equal(h2.events[0]!.urgent, false);
		assert.match(h2.events[0]!.text, /re-armed after restart/);
		assert.match(h2.events[0]!.text, /w-[\w-]+ \[still-waiting\]/);
		assert.match(h2.events[0]!.text, /Nothing fired while pi was down/);
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

	it("tail seeks: a multi-GB-shaped log costs the same as a small one", async () => {
		const h = makeHarness();
		const log = join(h.dir, "big.log");
		const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
		writeFileSync(log, lines.join("\n") + "\n"); // ~5MB
		const res = h.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			logPath: log,
			label: "big",
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const t0 = Date.now();
		const out = h.manager.tail(res.id, 3);
		assert.ok(Date.now() - t0 < 500, "tail is bounded work, not a full-file read");
		assert.match(out, /line 199999/);
		assert.doesNotMatch(out, /line 1 /, "early lines are not read");
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("caps live watches at MAX_WATCHES", () => {
		const h = makeHarness();
		for (let i = 0; i < 32; i++) {
			const r = h.manager.register({ kind: "parent" }, { trigger: { kind: "deadline", at: Date.now() + 60_000 } });
			assert.equal(r.ok, true, `watch ${i} registers`);
		}
		const over = h.manager.register({ kind: "parent" }, { trigger: { kind: "deadline", at: Date.now() + 60_000 } });
		assert.equal(over.ok, false);
		assert.match((over as { reason: string }).reason, /Too many watches/);
		h.manager.dispose();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("reaps stale terminal records at load but keeps recent history", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-watches-"));
		const storePath = watchStorePath(join(dir, "agent"), join(dir, "cwd"));
		mkdirSync(join(dir, "agent", "pi-submarine"), { recursive: true });
		const old = Date.now() - 30 * 24 * 60 * 60_000;
		const records = Array.from({ length: 25 }, (_, i) => ({
			id: `w-${i + 1}`,
			owner: { kind: "parent" },
			cwd: join(dir, "cwd"),
			label: `old-${i}`,
			createdAt: old,
			expiresAt: old + 1000,
			state: "fired",
			firedAt: old,
			logOffset: 0,
		}));
		writeFileSync(storePath, JSON.stringify({ version: 1, records }));
		const h = makeHarness({ storePath, cwd: join(dir, "cwd") });
		assert.equal(h.manager.list().length, 20, "newest 20 terminal records survive");
		h.manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("concurrent sessions sharing one store", () => {
	interface Duo {
		dir: string;
		storePath: string;
		cwd: string;
		alive: Set<number>;
		procIdentity: { bootId(): string; startTicks(pid: number): number | undefined; alive(pid: number): boolean };
		a: ReturnType<typeof makeHarness>;
		extra: Partial<WatchManagerOptions>;
	}

	function makeDuo(extra: Partial<WatchManagerOptions> = {}): Duo {
		const dir = mkdtempSync(join(tmpdir(), "pi-watches-"));
		const storePath = watchStorePath(join(dir, "agent"), join(dir, "cwd"));
		const cwd = join(dir, "cwd");
		const alive = new Set([100, 200]);
		const procIdentity = {
			bootId: () => "boot-A",
			startTicks: (pid: number) => (alive.has(pid) ? (pid === 100 ? 1 : pid === 200 ? 2 : undefined) : undefined),
			alive: (pid: number) => alive.has(pid),
		};
		const a = makeHarness({ storePath, cwd, procIdentity, selfIdentity: () => ({ pid: 100, start: 1 }), ...extra });
		return { dir, storePath, cwd, alive, procIdentity, a, extra };
	}

	function sibling(duo: Duo) {
		return makeHarness({
			storePath: duo.storePath,
			cwd: duo.cwd,
			procIdentity: duo.procIdentity,
			selfIdentity: () => ({ pid: 200, start: 2 }),
			...duo.extra,
		});
	}

	function cleanup(dir: string, ...hs: Array<ReturnType<typeof makeHarness>>): void {
		for (const h of hs) h.manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}

	it("a sibling's live claim means hands off — one wake, not two", async () => {
		const duo = makeDuo();
		const res = duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60 },
			label: "owned-by-a",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const b = sibling(duo);
		b.manager.reattachPending();
		b.manager.flushEvents();
		assert.ok(await waitFor(() => duo.a.events.length > 0), "owner (A) sees the fire");
		await delay(120);
		assert.equal(b.events.length, 0, "sibling (B) stays silent — A's waiters, A's wake");
		const view = b.manager.list().find((v) => v.id === res.id);
		assert.equal(view?.claimedBy, 100, "but it is visible in B's list, marked held by session 100");
		cleanup(duo.dir, duo.a, b);
	});

	it("cross-session cancel is honored by the owner via reconcile", async () => {
		const duo = makeDuo();
		const res = duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 250 },
			label: "cancel-me",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const b = sibling(duo);
		assert.equal(b.manager.cancel(res.id).ok, true, "B may cancel A's watch");
		await delay(450);
		assert.equal(duo.a.events.length, 0, "owner does not fire a cancelled watch");
		assert.equal(duo.a.manager.get(res.id)?.state, "cancelled", "owner adopted the terminal state");
		cleanup(duo.dir, duo.a, b);
	});

	it("cross-session extend pushes out the owner's expiry", async () => {
		const duo = makeDuo({ defaultLifetimeMs: 150 });
		const res = duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "extend-me",
		});
		assert.equal(res.ok, true);
		if (!res.ok) return;
		const b = sibling(duo);
		assert.equal(b.manager.extend(res.id, 10).ok, true, "B may extend A's watch");
		await delay(350); // past the original 150ms lifetime
		assert.equal(duo.a.events.length, 0, "no expiry after the sibling's extension");
		assert.ok(duo.a.manager.get(res.id)!.expiresAt - Date.now() > 60_000, "owner adopted the new expiry");
		cleanup(duo.dir, duo.a, b);
	});

	it("a dead holder's watch is taken over at adoption", async () => {
		const duo = makeDuo();
		const res = duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 150 },
			label: "orphaned",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		duo.a.manager.dispose();
		duo.alive.delete(100); // A's session is gone
		const b = sibling(duo);
		b.manager.reattachPending();
		assert.ok(await waitFor(() => b.events.some((e) => /fired at/.test(e.text)), 2000), "B waited on and fired A's abandoned watch");
		assert.equal(b.manager.list().find((v) => v.id === (res.ok ? res.id : ""))?.claimedBy, undefined, "and now holds it itself");
		cleanup(duo.dir, b);
	});

	it("runtime takeover: a sibling that dies mid-run is adopted on the tick", async () => {
		const duo = makeDuo();
		const res = duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 600 },
			label: "mid-run",
			lifetimeMinutes: 5,
		});
		assert.equal(res.ok, true);
		const b = sibling(duo);
		b.manager.reattachPending();
		assert.equal(b.events.length, 0, "hands off while A lives");
		duo.alive.delete(100); // A dies mid-run — note A's timers are STILL ticking
		assert.ok(await waitFor(() => b.events.some((e) => /took over/.test(e.text)), 2000), "B announces the takeover");
		assert.ok(await waitFor(() => b.events.some((e) => /fired at/.test(e.text)), 2000), "and completes the wait");
		assert.equal(duo.a.events.filter((e) => /fired at/.test(e.text)).length, 0, "the stale holder's late fire is suppressed — exactly one wake");
		cleanup(duo.dir, duo.a, b);
	});

	it("sibling records survive each other's saves", async () => {
		const duo = makeDuo();
		do {
			duo.a.manager.register({ kind: "parent" }, {
				trigger: { kind: "deadline", at: Date.now() + 60_000 },
				label: "a-1",
				lifetimeMinutes: 5,
			});
		} while (false); // A's first record, written to the store
		const b = sibling(duo);
		b.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "b-1",
			lifetimeMinutes: 5,
		});
		duo.a.manager.register({ kind: "parent" }, {
			trigger: { kind: "deadline", at: Date.now() + 60_000 },
			label: "a-2",
			lifetimeMinutes: 5,
		}); // A writes again, after B's record exists
		const raw = JSON.parse(readFileSync(duo.storePath, "utf-8")) as { records: Array<{ label: string }> };
		assert.deepEqual(raw.records.map((r) => r.label).sort(), ["a-1", "a-2", "b-1"]);
		cleanup(duo.dir, duo.a, b);
	});
});