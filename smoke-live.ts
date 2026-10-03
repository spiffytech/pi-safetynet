/**
 * smoke-live.ts — live end-to-end proof for pi-submarine watches.
 *
 * Spawns REAL headless pi (`pi -p`) against the real agent dir (this checkout
 * is the installed extension) with a scratch session dir + cwd, and asserts on
 * the session transcripts, the watch store, and process liveness:
 *
 *   S1 parent watch: `job_watch run` a fast job → heartbeat + fire events
 *      land in the session with the exit artifact verdict, tail pull works.
 *   S2 child watch: a subagent registers `job_watch` (SAME surface as the
 *      parent), ends its turn (status shows "waiting"), a fired watch resumes
 *      it, it reports upward.
 *   S3 restart survival: `run` job outlives SIGKILL of pi; the next pi adopts
 *      the record and reports "fired while pi was down" with a verdict.
 *   S4 timeout surfacing: a child segment aborted by the cap is reported as
 *      "Segment aborted after Ns while running: <cmd>", not plain idle.
 *   S5 attach: the model backgrounds work itself (setsid … &), then `attach`
 *      adopts it — survival verdict shown, and the job outlives SIGKILL of pi.
 *   S6 regex + re-arm: `^LINE$` exact-line matching survives a restart (full
 *      re-scan finds a line written while pi was dead) and a still-pending
 *      watch announces itself at adoption.
 *   S7 concurrent sessions: two live pi processes share one store — the
 *      sibling sees the watch marked "held by session N", and no duplicate
 *      record is created.
 *
 * Everything runs at seconds scale (env overrides), so the whole suite is
 * minutes, not hours. Run:  node --experimental-strip-types smoke-live.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.SMOKE_MODEL ?? "neuralwatt/deepseek-v4-flash";
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
	providerError?: string;
}

/** Provider refusals prove nothing about our code — bail loudly on them. */
const PROVIDER_ERROR = /(payment_required|insufficient|402\b|429\b|too_many_tokens|rate.?limit|quota)/i;

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
			const providerError = PROVIDER_ERROR.test(out)
				? (out.match(/"message":"([^"]+)"/)?.[1] ?? "provider error").slice(0, 140)
				: undefined;
			resolve({ code, out, killed, ...(providerError ? { providerError } : {}) });
		});
	});
	const first = await attempt();
	// Provider quota bursts (429) are transient: back off and retry once.
	if (!first.killed && first.providerError && /429|too_many|rate.?limit/i.test(first.providerError)) {
		console.log("  (429 rate limit — backing off 70s and retrying)");
		await sleep(70_000);
		return attempt();
	}
	return first;
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
/** SMOKE_ONLY=S5 runs just that scenario (comma-separated also fine). */
function wants(scenario: string): boolean {
	const only = process.env.SMOKE_ONLY;
	return !only || only.split(",").map((s) => s.trim()).includes(scenario);
}
function assert(name: string, cond: boolean, detail = ""): void {
	checks.push({ name, ok: cond, detail });
	console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : ` — ${detail}`}`);
}

/** A provider-refused run proves nothing: fail the scenario loudly instead of
 *  letting later asserts match prompt text. Returns true when bailed. */
function bailOnProviderError(run: PiRun, scenario: string): boolean {
	if (!run.providerError) return false;
	assert(`${scenario} provider accepted the run`, false, `provider error: ${run.providerError}`);
	return true;
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

async function s1ParentWatch(): Promise<void> {
	if (!wants("S1")) return;
	console.log("\nS1: parent watch (run + heartbeat + fire + tail)");
	const before = sessionText();
	const log = join(SCRATCH, "s1.log");
	const run = await runPi(
		`Call the job_watch tool with action 'run', command 'for i in 1 2 3; do echo progress-$i; sleep 1; done; echo ALL-DONE', ` +
			`logPath '${log}', heartbeatSeconds 2, label 'smoke1'. ` +
			`Then run bash 'sleep 8'. Then call job_watch with action 'list'. ` +
			`Then end your reply with exactly the line: SMOKE-OK1`,
	);
	const text = deltaSince(before) + run.out;
	if (bailOnProviderError(run, "S1")) return;
	assert("S1 pi exited cleanly", run.code === 0, `code=${run.code} out-tail=${run.out.slice(-200)}`);
	assert("S1 heartbeat events reached the session", /watch-event/.test(text) && /heartbeat at/.test(text));
	assert("S1 fire event carries the exit artifact verdict", /fired at .*pid \d+ exited \(exit artifact present: exit 0\)/s.test(text));
	assert("S1 tail pull shows the job's own output", /ALL-DONE/.test(text));
	const rec = storeRecords().find((r) => r.label === "smoke1");
	assert("S1 store shows the watch fired", rec?.state === "fired", JSON.stringify(rec));
	assert("S1 agent finished with the marker", text.includes("SMOKE-OK1"), run.out.slice(-300));
}

async function s2ChildWatch(): Promise<void> {
	if (!wants("S2")) return;
	console.log("\nS2: child watch (waiting state + resume + report)");
	const before = sessionText();
	const file = join(SCRATCH, "child.txt");
	const log = join(SCRATCH, "s2.log");
	const childPrompt =
		`Use the job_watch tool with action 'register', path '${file}', pattern 'CHILD-DONE', label 'smoke2'. ` +
		`Then END YOUR TURN immediately without waiting. When you are resumed by a watch event, ` +
		`call report_to_parent with summary 'resumed-and-seen' and urgent true, then end with the line: SMOKE-OK2`;
	const run = await runPi(
		`Do these steps in order: ` +
			`(1) Call subagent_run with this prompt: "${childPrompt}". ` +
			`(2) Poll for the child to settle after registering: call subagent_status; if it does not show 'waiting', run bash 'sleep 3' and call subagent_status again — repeat up to 15 times, and only move on once you have SEEN the status show 'waiting' (or after 15 tries). ` +
			`(3) Call job_watch with action 'run', command 'sleep 4; echo CHILD-DONE >> ${file}', logPath '${log}', label 'smoke2-trigger'. ` +
			`(4) Run bash 'sleep 12'. ` +
			`(5) Call subagent_status. ` +
			`Then end your reply with exactly the line: SMOKE-OK2P`,
	);
	const text = deltaSince(before) + run.out;
	if (bailOnProviderError(run, "S2")) return;
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
	if (!wants("S3")) return;
	console.log("\nS3: restart survival (job outlives pi, down-time verdict)");
	const before = sessionText();
	const file = join(SCRATCH, "s3.log");
	const run1 = runPi(
		`Call job_watch with action 'run', command 'sleep 6; echo RESTART-DONE >> ${file}', logPath '${file}', label 'smoke3'. ` +
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
		`Call job_watch with action 'list' and quote its output verbatim in your reply. ` +
			`Then end your reply with exactly the line: SMOKE-OK3`,
	);
	const text2 = deltaSince(before) + r2.out;
	if (bailOnProviderError(r2, "S3")) return;
	assert("S3 second pi exited cleanly", r2.code === 0, `code=${r2.code} out-tail=${r2.out.slice(-300)}`);
	assert("S3 adopted record fired with a down-time verdict", /fired while pi was down/.test(text2));
	assert("S3 verdict distinguishes clean finish via exit artifact", /exit artifact present: exit 0/.test(text2));
	assert("S3 agent finished with the marker", text2.includes("SMOKE-OK3"), r2.out.slice(-300));
}

async function s4TimeoutSurfacing(): Promise<void> {
	if (!wants("S4")) return;
	console.log("\nS4: segment-timeout abort surfacing (aborted vs idle)");
	const before = sessionText();
	const run = await runPi(
		`Call subagent_run with this prompt: "Run this bash command exactly once: sleep 30. Do nothing else." ` +
			`Then run bash 'sleep 15'. Then call subagent_status. Then end your reply with exactly the line: SMOKE-OK4`,
		{ env: { PI_SUBMARINE_SEGMENT_TIMEOUT_MS: "4000" } },
	);
	const text = deltaSince(before) + run.out;
	if (bailOnProviderError(run, "S4")) return;
	assert("S4 pi exited cleanly", run.code === 0, `code=${run.code}`);
	assert("S4 abort rides a report naming the killed command", /Segment aborted after 4s while running: sleep 30/.test(text));
	assert("S4 status shows aborted, not plain idle", /aborted at 4s while running: sleep 30/.test(text));
	assert("S4 agent finished with the marker", text.includes("SMOKE-OK4"), run.out.slice(-300));
}

async function s5Attach(): Promise<void> {
	if (!wants("S5")) return;
	console.log("\nS5: attach (model backgrounds work itself, then adopts it)");
	const before = sessionText();
	const file = join(SCRATCH, "s5.log");
	const run1 = runPi(
		`Do exactly this: (1) Run bash: ` +
			`setsid nohup bash -c 'sleep 8; echo ATTACH-DONE >> ${file}' > ${file} 2>&1 < /dev/null & echo "PID=$!" ` +
			`and read the PID number from the output. ` +
			`(2) Call job_watch with action 'attach', pid <that PID number>, logPath '${file}', label 'smoke5'. ` +
			`(3) Run bash 'sleep 30'.`,
		{ killWhen: () => storeRecords().some((r) => r.label === "smoke5") },
	);
	const r1 = await run1;
	const text1 = deltaSince(before) + r1.out;
	if (bailOnProviderError(r1, "S5")) return;
	assert("S5 pi was SIGKILLed after adoption", r1.killed, `code=${r1.code}`);
	assert("S5 attach registered in the store", storeRecords().some((r) => r.label === "smoke5"));
	assert("S5 attach reported the survival verdict", /survives pi exiting/.test(text1), text1.slice(-300));
	assert("S5 the adopted job survived pi's death", spawnSync("pgrep", ["-f", "ATTACH-DONE"]).status === 0);
	await waitFor(() => existsSync(file) && readFileSync(file, "utf-8").includes("ATTACH-DONE"), 30_000, "attached job completion");
	const r2 = await runPi(
		`Call job_watch with action 'list' and quote its output verbatim in your reply. ` +
			`Then end your reply with exactly the line: SMOKE-OK5`,
	);
	const text2 = deltaSince(before) + r2.out;
	if (bailOnProviderError(r2, "S5b")) return;
	assert("S5 second pi exited cleanly", r2.code === 0, `code=${r2.code}`);
	assert("S5 adopted record fired with a down-time verdict", /fired while pi was down/.test(text2));
	assert("S5 agent finished with the marker", text2.includes("SMOKE-OK5"), r2.out.slice(-300));
}

async function s6RegexAndRearm(): Promise<void> {
	if (!wants("S6")) return;
	console.log("\nS6: exact-line regex across restart + re-arm notice");
	const before = sessionText();
	const file = join(SCRATCH, "s6.log");
	writeFileSync(file, "booting\n");
	const run1 = runPi(
		`Do exactly this: (1) Call job_watch with action 'register', path '${file}', pattern '^READY-NOW$', logPath '${file}', label 'smoke6a'. ` +
			`(2) Call job_watch with action 'register', deadlineSeconds 600, label 'smoke6b'. ` +
			`(3) Run bash 'sleep 30'.`,
		{ killWhen: () => storeRecords().filter((r) => (r.label === "smoke6a" || r.label === "smoke6b")).length === 2 },
	);
	const r1 = await run1;
	if (bailOnProviderError(r1, "S6")) return;
	assert("S6 pi was SIGKILLed with both watches registered", r1.killed, `code=${r1.code}`);
	// The matching line lands while pi is dead — the re-scan must find it.
	appendFileSync(file, "not this one\nREADY-NOW\n");
	const r2 = await runPi(
		`Call job_watch with action 'list' and quote its output verbatim in your reply. ` +
			`Then end your reply with exactly the line: SMOKE-OK6`,
	);
	const text2 = deltaSince(before) + r2.out;
	if (bailOnProviderError(r2, "S6b")) return;
	assert("S6 second pi exited cleanly", r2.code === 0, `code=${r2.code}`);
	assert("S6 exact-line regex fired on data written while pi was down", /fired while pi was down/.test(text2) && /READY-NOW/.test(text2));
	assert("S6 still-pending watch announced at re-arm", /re-armed after restart/.test(text2) && /smoke6b/.test(text2));
	assert("S6 agent finished with the marker", text2.includes("SMOKE-OK6"), r2.out.slice(-300));
}

async function s7ConcurrentSessions(): Promise<void> {
	if (!wants("S7")) return;
	console.log("\nS7: two live sessions, one store (claim + transparency)");
	const before = sessionText();
	const run1 = runPi(
		`Do exactly this: (1) Call job_watch with action 'register', deadlineSeconds 900, label 's7-shared', lifetimeMinutes: 30. ` +
			`(2) Run bash 'sleep 25'.`,
		{ timeoutMs: 120_000 },
	);
	await waitFor(() => storeRecords().some((r) => r.label === "s7-shared"), 90_000, "run1 registers its watch");
	// Second live session, same cwd, while run1 is still up:
	const r2 = await runPi(
		`Call job_watch with action 'list' and quote its output verbatim in your reply. ` +
			`Then end your reply with exactly the line: SMOKE-OK7`,
	);
	const text2 = deltaSince(before) + r2.out;
	if (bailOnProviderError(r2, "S7b")) {
		await run1;
		return;
	}
	assert("S7 second pi exited cleanly", r2.code === 0, `code=${r2.code}`);
	assert("S7 sibling sees the watch, held by the other session", /held by session \d+/.test(text2), text2.slice(-300));
	assert("S7 agent finished with the marker", text2.includes("SMOKE-OK7"), r2.out.slice(-300));
	const recs = storeRecords().filter((r) => r.label === "s7-shared");
	assert("S7 exactly one record exists — no duplication across sessions", recs.length === 1, JSON.stringify(recs));
	const r1 = await run1;
	if (bailOnProviderError(r1, "S7a")) return;
	assert("S7 first pi finished cleanly", r1.code === 0, `code=${r1.code}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

try {
	console.log(`smoke-live: model=${MODEL}`);
	console.log(`scratch=${SCRATCH}`);
	await s1ParentWatch();
	await s2ChildWatch();
	await s3RestartSurvival();
	await s4TimeoutSurfacing();
	await s5Attach();
	await s6RegexAndRearm();
	await s7ConcurrentSessions();
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