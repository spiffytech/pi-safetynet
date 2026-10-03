/**
 * smoke-live.ts — live end-to-end proof for pi-submarine watches.
 *
 * Spawns REAL headless pi (`pi -p`) against the real agent dir (this checkout
 * is the installed extension) with a scratch session dir + cwd, and asserts on
 * the session transcripts, the watch store, and process liveness:
 *
 *   S1 parent watch: `subagent_watch run` a fast job → heartbeat + fire events
 *      land in the session with the exit artifact verdict, tail pull works.
 *   S2 child watch: a subagent registers `watch_for`, ends its turn (status
 *      shows "waiting"), a fired watch resumes it, it reports upward.
 *   S3 restart survival: `watch run` job outlives SIGKILL of pi; the next pi
 *      adopts the record and reports "fired while pi was down" with a verdict.
 *   S4 timeout surfacing: a child segment aborted by the cap is reported as
 *      "Segment aborted after Ns while running: <cmd>", not plain idle.
 *
 * Everything runs at seconds scale (env overrides), so the whole suite is
 * minutes, not hours. Run:  node --experimental-strip-types smoke-live.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.SMOKE_MODEL ?? "cerebras/qwen-3.8-27b";
const SCRATCH = mkdtempSync(join(tmpdir(), "pi-smoke-live-"));
const WORK = join(SCRATCH, "work");
const SESSIONS = join(SCRATCH, "sessions");
const AGENT_DIR = process.env.PI_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;
mkdirSync(WORK, { recursive: true });
mkdirSync(SESSIONS, { recursive: true });

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await sleep(250);
	}
	if (!cond()) throw new Error(`timeout waiting for: ${what}`);
}

/** All session transcripts produced so far, concatenated. */
function sessionText(): string {
	return readdirSync(SESSIONS)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			try {
				return readFileSync(join(SESSIONS, f), "utf-8");
			} catch {
				return "";
			}
		})
		.join("\n");
}

/** Session transcript content produced since a snapshot (per-scenario
 *  isolation: earlier scenarios' events must not satisfy later assertions). */
function deltaSince(snapshot: string): string {
	return sessionText().slice(snapshot.length);
}

/** Watch store records whose cwd is this smoke's work dir. */
function storeRecords(): Array<Record<string, unknown>> {
	const dir = join(AGENT_DIR, "pi-submarine");
	if (!existsSync(dir)) return [];
	const out: Array<Record<string, unknown>> = [];
	for (const f of readdirSync(dir)) {
		if (!f.startsWith("watches-") || !f.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { records?: Array<Record<string, unknown>> };
			for (const rec of parsed.records ?? []) {
				if (rec.cwd === WORK) out.push(rec);
			}
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

interface PiRun {
	code: number | null;
	out: string;
	killed: boolean;
}

async function runPi(prompt: string, opts: { env?: Record<string, string>; killWhen?: () => boolean; timeoutMs?: number } = {}): Promise<PiRun> {
	const args = [
		"-p", prompt,
		"--model", MODEL,
		"--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
		"--session-dir", SESSIONS,
		"--build",
		"--allow", "bash: *, edit: *, read: *",
	];
	const env = {
		...process.env,
		PI_SUBMARINE_WATCH_MIN_HEARTBEAT_MS: "1500",
		PI_SUBMARINE_WATCH_POLL_MS: "200",
		...opts.env,
	};
	// stdin MUST be ignored: with a pipe stdin pi blocks reading it forever.
	const attempt = (): Promise<PiRun> => new Promise((resolve) => {
		const child = spawn("pi", args, { cwd: WORK, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += String(d)));
		child.stderr.on("data", (d) => (out += String(d)));
		let killed = false;
		const killTimer = opts.killWhen
			? setInterval(() => {
					if (opts.killWhen!()) {
						killed = true;
						child.kill("SIGKILL");
					}
				}, 200)
			: undefined;
		// Hard cap so no scenario can hang the suite.
		const hardTimer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, opts.timeoutMs ?? 240_000);
		child.on("exit", (code) => {
			if (killTimer) clearInterval(killTimer);
			clearTimeout(hardTimer);
			resolve({ code, out, killed });
		});
	});
	const first = await attempt();
	// Provider quota bursts (429) are transient: back off and retry once.
	if (!first.killed && /429|too_many_tokens|rate.?limit/i.test(first.out)) {
		console.log("  (429 rate limit — backing off 70s and retrying)");
		await sleep(70_000);
		return attempt();
	}
	return first;
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function assert(name: string, cond: boolean, detail = ""): void {
	checks.push({ name, ok: cond, detail });
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

async function s1ParentWatch(): Promise<void> {
	console.log("\nS1: parent watch (run + heartbeat + fire + tail)");
	const before = sessionText();
	const log = join(SCRATCH, "s1.log");
	const run = await runPi(
		`Call the subagent_watch tool with action 'run', command 'for i in 1 2 3; do echo progress-$i; sleep 1; done; echo ALL-DONE', ` +
			`logPath '${log}', heartbeatSeconds 2, label 'smoke1'. ` +
			`Then run bash 'sleep 8'. Then call subagent_watch with action 'list'. ` +
			`Then end your reply with exactly the line: SMOKE-OK1`,
	);
	const text = deltaSince(before) + run.out;
	assert("S1 pi exited cleanly", run.code === 0, `code=${run.code} out-tail=${run.out.slice(-200)}`);
	assert("S1 heartbeat events reached the session", /watch-event/.test(text) && /heartbeat at/.test(text));
	assert("S1 fire event carries the exit artifact verdict", /fired at .*pid \d+ exited \(exit artifact present: exit 0\)/s.test(text));
	assert("S1 tail pull shows the job's own output", /ALL-DONE/.test(text));
	const rec = storeRecords().find((r) => r.label === "smoke1");
	assert("S1 store shows the watch fired", rec?.state === "fired", JSON.stringify(rec));
	assert("S1 agent finished with the marker", text.includes("SMOKE-OK1"), run.out.slice(-300));
}

async function s2ChildWatch(): Promise<void> {
	console.log("\nS2: child watch (waiting state + resume + report)");
	const before = sessionText();
	const file = join(SCRATCH, "child.txt");
	const log = join(SCRATCH, "s2.log");
	const childPrompt =
		`Use the watch_for tool with action 'register', path '${file}', pattern 'CHILD-DONE', label 'smoke2'. ` +
		`Then END YOUR TURN immediately without waiting. When you are resumed by a watch event, ` +
		`call report_to_parent with summary 'resumed-and-seen' and urgent true, then end with the line: SMOKE-OK2`;
	const run = await runPi(
		`Do these steps in order: ` +
			`(1) Call subagent_run with this prompt: "${childPrompt}". ` +
			`(2) Poll for the child to settle after registering: call subagent_status; if it does not show 'waiting', run bash 'sleep 3' and call subagent_status again — repeat up to 15 times, and only move on once you have SEEN the status show 'waiting' (or after 15 tries). ` +
			`(3) Call subagent_watch with action 'run', command 'sleep 4; echo CHILD-DONE >> ${file}', logPath '${log}', label 'smoke2-trigger'. ` +
			`(4) Run bash 'sleep 12'. ` +
			`(5) Call subagent_status. ` +
			`Then end your reply with exactly the line: SMOKE-OK2P`,
	);
	const text = deltaSince(before) + run.out;
	assert("S2 pi exited cleanly", run.code === 0, `code=${run.code} out-tail=${run.out.slice(-200)}`);
	assert("S2 child was observed waiting on its watch", /waiting on watch|\[waiting\]/.test(text));
	// The child's report arrives as "[sub-1] <summary>" — assert on that, not the
	// bare phrase (which the parent prompt itself contains).
	assert("S2 fired watch resumed the child, which reported", /\[sub-1\] resumed-and-seen/.test(text));
	const childRec = storeRecords().find((r) => r.label === "smoke2");
	assert("S2 child-owned watch fired in the store", childRec?.state === "fired" && (childRec?.owner as { kind?: string })?.kind === "child", JSON.stringify(childRec));
	assert("S2 agent finished with the marker", text.includes("SMOKE-OK2P"), run.out.slice(-300));
}

async function s3RestartSurvival(): Promise<void> {
	console.log("\nS3: restart survival (job outlives pi, down-time verdict)");
	const before = sessionText();
	const file = join(SCRATCH, "s3.log");
	const run1 = runPi(
		`Call subagent_watch with action 'run', command 'sleep 6; echo RESTART-DONE >> ${file}', logPath '${file}', label 'smoke3'. ` +
			`Then run bash 'sleep 45'.`,
		{ killWhen: () => storeRecords().some((r) => r.label === "smoke3") },
	);
	const r1 = await run1;
	assert("S3 pi was SIGKILLed mid-wait", r1.killed, `code=${r1.code}`);
	assert("S3 the detached job survived pi's death", spawnSync("pgrep", ["-f", "echo RESTART-DONE"]).status === 0);
	// Wait for the job to finish while pi stays dead.
	await waitFor(() => existsSync(file) && readFileSync(file, "utf-8").includes("RESTART-DONE"), 30_000, "job completion");
	await waitFor(() => storeRecords().some((r) => r.label === "smoke3" && r.verdict === undefined), 2_000, "store settled").catch(() => {});
	const r2 = await runPi(
		`Call subagent_watch with action 'list' and quote its output verbatim in your reply. ` +
			`Then end your reply with exactly the line: SMOKE-OK3`,
	);
	const text2 = deltaSince(before) + r2.out;
	assert("S3 second pi exited cleanly", r2.code === 0, `code=${r2.code} out-tail=${r2.out.slice(-300)}`);
	assert("S3 adopted record fired with a down-time verdict", /fired while pi was down/.test(text2));
	assert("S3 verdict distinguishes clean finish via exit artifact", /exit artifact present: exit 0/.test(text2));
	assert("S3 agent finished with the marker", text2.includes("SMOKE-OK3"), r2.out.slice(-300));
}

async function s4TimeoutSurfacing(): Promise<void> {
	console.log("\nS4: segment-timeout abort surfacing (aborted vs idle)");
	const before = sessionText();
	const run = await runPi(
		`Call subagent_run with this prompt: "Run this bash command exactly once: sleep 30. Do nothing else." ` +
			`Then run bash 'sleep 15'. Then call subagent_status. Then end your reply with exactly the line: SMOKE-OK4`,
		{ env: { PI_SUBMARINE_SEGMENT_TIMEOUT_MS: "4000" } },
	);
	const text = deltaSince(before) + run.out;
	assert("S4 pi exited cleanly", run.code === 0, `code=${run.code}`);
	assert("S4 abort rides a report naming the killed command", /Segment aborted after 4s while running: sleep 30/.test(text));
	assert("S4 status shows aborted, not plain idle", /aborted at 4s while running: sleep 30/.test(text));
	assert("S4 agent finished with the marker", text.includes("SMOKE-OK4"), run.out.slice(-300));
}

// ─── Main ──────────────────────────────────────────────────────────────────

try {
	console.log(`smoke-live: model=${MODEL}`);
	console.log(`scratch=${SCRATCH}`);
	await s1ParentWatch();
	await s2ChildWatch();
	await s3RestartSurvival();
	await s4TimeoutSurfacing();
} catch (err) {
	assert("scenario completed without throwing", false, String(err));
} finally {
	const failed = checks.filter((c) => !c.ok);
	console.log(`\n==== smoke-live: ${checks.length - failed.length}/${checks.length} checks passed ====`);
	if (failed.length > 0 || process.env.SMOKE_KEEP) {
		console.log(`scratch kept for inspection: ${SCRATCH}`);
	} else {
		rmSync(SCRATCH, { recursive: true, force: true });
		spawnSync("bash", ["-c", `grep -l '"${WORK}"' ${AGENT_DIR}/pi-submarine/watches-*.json 2>/dev/null | xargs -r rm -f`]);
	}
	if (failed.length > 0) {
		console.error("FAILED:", failed.map((f) => `${f.name}${f.detail ? ` (${f.detail.slice(0, 140)})` : ""}`).join("; "));
		process.exitCode = 1;
	}
}