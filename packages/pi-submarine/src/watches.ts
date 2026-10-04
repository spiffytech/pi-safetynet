/**
 * watches.ts — the watch engine: registrations that wake a parent or resume a
 * child on pid-exit / file-pattern / deadline / heartbeat, with NO agent
 * sleeping anywhere. Waiting lives in kernel-level polling + timers; the only
 * LLM involvement is the wake (parent) or resume (child) at event time.
 *
 * Persistence-first: every record is written to a JSON store as it changes, so
 * pi dying mid-watch loses nothing. On the next session start the store is
 * reloaded, conditions are re-evaluated (events that fired while pi was down
 * surface immediately with a verdict), and waiters are re-armed.
 *
 * Everything time-ish is injectable so unit tests run at millisecond scale;
 * live fast modes use the PI_SUBMARINE_WATCH_* env overrides wired in index.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readSync, openSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { lockSync } from "proper-lockfile";
import type { WatchInput, WatchOwner, WatchTrigger, WatchView } from "pi-submarine-core";
import { capReportSummary, capBashTail, readProcStat, readBootId, validatePatternRegex } from "pi-submarine-core";

export interface WatchRecord {
	id: string;
	owner: WatchOwner;
	cwd: string;
	label: string;
	trigger?: WatchTrigger;
	heartbeatMs?: number;
	logPath?: string;
	createdAt: number;
	expiresAt: number;
	state: "pending" | "fired" | "cancelled" | "expired";
	firedAt?: number;
	verdict?: string;
	/** Teardown-survival verdict recorded at attach time. */
	survival?: string;
	/** Identity captured at register: boot id + process start ticks. A pid alone
	 *  is not an identity — pids recycle across reboots. */
	bootId?: string;
	procStart?: number;
	/** Death guard: identity of the guarding pid (fires the watch when it ends). */
	guardPid?: number;
	guardBootId?: string;
	guardStart?: number;
	/** Process identity of the session that owns the waiters. Two live pi
	 *  sessions share one store: only the claim holder arms/announces; everyone
	 *  else sees the record in list and may cancel/extend it. */
	claim?: { pid: number; start?: number };
	/** Byte offset into logPath already scanned for the pattern/preview. */
	logOffset: number;
	lastLine?: string;
	/** file-quiet bookkeeping: last observed size + when it last grew. */
	quietLastSize?: number;
	lastGrowthAt?: number;
	/** Pre-expiry warning sent once per lifetime (reset by extend). */
	expiryWarned?: boolean;
}

export interface WatchManagerOptions {
	/** Where records persist. One store per cwd, so adoption is automatic. */
	storePath: string;
	cwd: string;
	/** Smallest allowed heartbeat (guards against wake spam). */
	minHeartbeatMs?: number;
	/** Trigger polling interval (also drives heartbeats/expiry — one shared tick). */
	pollIntervalMs?: number;
	/** Default watch lifetime when the input sets none (30 min). */
	defaultLifetimeMs?: number;
	/** Hard ceiling for any lifetime or extension (the forgotten-watch guillotine). */
	maxLifetimeMs?: number;
	now?: () => number;
	/** Deliver an event to the parent session (urgent = triggers a turn).
	 *  `display` marks human-visible entries (fires/warnings/notices — NOT
	 *  heartbeats, which would spam the transcript). */
	sendParentEvent(text: string, urgent: boolean, display?: boolean): void;
	/** Resume a child job with an event. Returns false when the job is gone. */
	resumeChild(jobId: string, text: string): boolean;
	/** Whether a child job is still live (restart-orphan detection at reattach). */
	isChildLive?(jobId: string): boolean;
	/** Kernel identity probes (boot id, process start ticks). */
	procIdentity?: ProcIdentity;
	/** This session's process identity (claims). Injectable so tests can
	 *  simulate two live sessions in one process. */
	selfIdentity?: () => { pid: number; start?: number };
	/** Human-facing liveness: called whenever watch state changes so a UI can
	 *  show what is owned and being waited on. */
	onStateChange?(): void;
	/** Deferral gate: false while the parent compacts or is mid-turn. */
	canDeliver?(): boolean;
}

export interface WatchEvent {
	id: string;
	kind: "terminal" | "heartbeat";
	text: string;
	at: number;
}

const DEFAULT_MIN_HEARTBEAT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LIFETIME_MS = 30 * 60_000;
const DEFAULT_MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;
/** Terminal records older than this are reaped at load (store hygiene). */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** ...but always keep at least this many terminal records for history. */
const TERMINAL_KEEP = 20;
/** Cap on live watches: each is polled every tick. */
export const MAX_WATCHES = 32;
/** `tail` reads at most this many trailing bytes (never the whole log). */
const TAIL_READ_BYTES = 256 * 1024;
const LAST_LINE_MAX = 200;
/** Re-scan window carried between polls: longer than any plausible match. */
export const OVERLAP_BYTES = 4096;

/**
 * Streaming regex matcher — the pure core of file scanning. Feed raw bytes as
 * they arrive (ANY split); it matches against a sliding window of recent text.
 *
 * Contract (what the property tests assert):
 *   - COMPLETENESS: if the pattern matches the full accumulated text, some feed
 *     returns hit=true — a match split across chunk boundaries is never missed
 *     (the window re-covers up to OVERLAP_BYTES of prior bytes).
 *   - Multibyte-safe: a UTF-8 character split across feeds still matches
 *     (StringDecoder holds partial sequences instead of baking in U+FFFD).
 *   - Streaming semantics, like `tail -f | grep`: an m-flagged `^…$` can match
 *     a line before its trailing newline lands.
 */
export class IncrementalMatcher {
	private decoder = new StringDecoder("utf-8");
	private window = "";
	private readonly re: RegExp | undefined;

	constructor(pattern?: string) {
		this.re = pattern !== undefined ? new RegExp(pattern, "m") : undefined;
	}

	/** Feed the next bytes; returns the text seen and whether it matches now. */
	feed(chunk: Buffer): { text: string; hit: boolean } {
		this.window += this.decoder.write(chunk);
		const text = this.window;
		const hit = this.re ? this.re.test(text) : false;
		this.window = text.length > OVERLAP_BYTES ? text.slice(-OVERLAP_BYTES) : text;
		return { text, hit };
	}

	/** Truncation/rotation: forget the stream and start over. */
	reset(): void {
		this.decoder = new StringDecoder("utf-8");
		this.window = "";
	}
}
const STORE_VERSION = 1;
/** Exit artifact appended by `watch run`'s wrapper, used for down-time verdicts. */
export const WATCH_EXIT_MARKER = "__WATCH_EXIT=";

/** Store path for a cwd: one JSON file per working directory. */
export function watchStorePath(agentDir: string, cwd: string): string {
	const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(agentDir, "pi-submarine", `watches-${key}.json`);
}

export class WatchManager {
	private readonly opts: Required<Omit<WatchManagerOptions, "now" | "canDeliver" | "isChildLive" | "procIdentity" | "selfIdentity" | "onStateChange">> & {
		now: () => number;
		canDeliver: () => boolean;
		isChildLive: (jobId: string) => boolean;
		procIdentity: ProcIdentity;
		selfIdentity: () => { pid: number; start?: number };
		onStateChange: () => void;
	};
	private readonly records = new Map<string, WatchRecord>();
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private readonly lastBeatAt = new Map<string, number>();
	private readonly pendingEvents: Array<{ text: string; urgent: boolean; display: boolean }> = [];
	private readonly matchers = new Map<string, IncrementalMatcher>();
	private readonly reaped = new Set<string>();
	private lastReconcileMtime = 0;
	private counter = 0;
	private disposed = false;
	/** True while adopting persisted records: events must not be sent at
	 *  session_start (pi rejects sends before the first turn settles); they
	 *  drain at the first turn boundary instead. */
	private holdDelivery = false;

	constructor(options: WatchManagerOptions) {
		this.opts = {
			storePath: options.storePath,
			cwd: options.cwd,
			minHeartbeatMs: options.minHeartbeatMs ?? DEFAULT_MIN_HEARTBEAT_MS,
			pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
			defaultLifetimeMs: options.defaultLifetimeMs ?? DEFAULT_LIFETIME_MS,
			maxLifetimeMs: options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
			now: options.now ?? (() => Date.now()),
			sendParentEvent: options.sendParentEvent,
			resumeChild: options.resumeChild,
			isChildLive: options.isChildLive ?? (() => false),
			procIdentity: options.procIdentity ?? realProcIdentity,
			selfIdentity:
				options.selfIdentity ??
				(() => {
					const start = readProcStat(process.pid).start;
					return { pid: process.pid, ...(start !== undefined ? { start } : {}) };
				}),
			onStateChange: options.onStateChange ?? (() => {}),
			canDeliver: options.canDeliver ?? (() => true),
		};
		this.load();
		// The shared tick runs for the manager's whole life (not per record): a
		// session with zero claimed watches must still notice sibling records,
		// their deaths (takeover), and their updates (reconcile).
		this.tickTimer = setInterval(() => this.runTick(), this.opts.pollIntervalMs);
		this.tickTimer.unref?.();
	}

	private now(): number {
		return this.opts.now();
	}

	// ─── Persistence ────────────────────────────────────────────────────────

	private load(): void {
		let raw: string;
		try {
			raw = readFileSync(this.opts.storePath, "utf-8");
		} catch {
			return;
		}
		try {
			const parsed = JSON.parse(raw) as { version?: number; records?: WatchRecord[] };
			for (const rec of parsed.records ?? []) {
				if (rec && typeof rec.id === "string" && rec.cwd === this.opts.cwd) {
					this.records.set(rec.id, rec);
				}
			}
			const maxId = [...this.records.keys()]
				.map((id) => Number(id.replace(/^w-/, "")))
				.filter((n) => Number.isFinite(n))
				.reduce((a, b) => Math.max(a, b), 0);
			this.counter = maxId;
			// Store hygiene: reap stale terminal records, keeping recent history.
			const terminal = [...this.records.values()].filter((r) => r.state !== "pending");
			terminal.sort((a, b) => (b.firedAt ?? b.createdAt) - (a.firedAt ?? a.createdAt));
			const cutoff = this.now() - TERMINAL_RETENTION_MS;
			terminal.forEach((r, i) => {
				// Never reap a record a live sibling session is still waiting on.
				if (i >= TERMINAL_KEEP && (r.firedAt ?? r.createdAt) < cutoff && !this.claimLive(r)) {
					this.records.delete(r.id);
					this.reaped.add(r.id);
				}
			});
		} catch {
			/* corrupt store: start clean rather than refuse to run */
		}
	}

	/** Synchronous store lock (mirrors pi-safetynet's json-store pattern —
	 *  two live sessions in one cwd share this file). */
	private withLock<T>(fn: () => T): T {
		mkdirSync(dirname(this.opts.storePath), { recursive: true });
		if (!existsSync(this.opts.storePath)) writeFileSync(this.opts.storePath, '{"version":1,"records":[]}\n');
		let release: () => void = () => {};
		for (let attempt = 1; ; attempt++) {
			try {
				release = lockSync(this.opts.storePath, { realpath: false });
				break;
			} catch (err) {
				const code =
					typeof err === "object" && err !== null && "code" in err
						? String((err as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt >= 10) throw err;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
			}
		}
		try {
			return fn();
		} finally {
			release();
		}
	}

	private readFileRecords(): Map<string, WatchRecord> {
		try {
			const parsed = JSON.parse(readFileSync(this.opts.storePath, "utf-8")) as { records?: WatchRecord[] };
			return new Map((parsed.records ?? []).filter((r) => r && typeof r.id === "string").map((r) => [r.id, r]));
		} catch {
			return new Map();
		}
	}

	private writeFileRecords(records: WatchRecord[]): void {
		const tmp = `${this.opts.storePath}.tmp`;
		writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, records }, null, 2));
		renameSync(tmp, this.opts.storePath);
	}

	private self(): { pid: number; start?: number } {
		return this.opts.selfIdentity();
	}

	private isMine(rec: WatchRecord): boolean {
		return rec.claim === undefined || rec.claim.pid === this.self().pid;
	}

	/** True when the claim holder process is still alive (pid + start ticks). */
	private claimLive(rec: WatchRecord): boolean {
		const c = rec.claim;
		if (!c) return false;
		if (c.pid === this.self().pid) return true;
		const start = this.opts.procIdentity.startTicks(c.pid);
		if (c.start !== undefined) {
			if (start !== undefined) return start === c.start;
			// Start ticks unreadable but the pid exists: assume the holder lives —
			// a transient read hiccup must never cause a spurious takeover.
			return this.opts.procIdentity.alive(c.pid);
		}
		return start !== undefined || this.opts.procIdentity.alive(c.pid);
	}

	/**
	 * The ONE persistence primitive: a locked read-merge-write over the store.
	 * Every write path is a policy over it — the plumbing exists exactly once.
	 */
	private commit<T>(mutate: (fileRecs: Map<string, WatchRecord>) => T): T | undefined {
		try {
			return this.withLock(() => {
				const fileRecs = this.readFileRecords();
				const result = mutate(fileRecs);
				this.writeFileRecords([...fileRecs.values()]);
				return result;
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Take the waiter claim for this session — the concurrency core. False when
	 * a live sibling session already holds it (its waiters, its wakes; we just
	 * watch it in list). Stale claims (dead holder) are taken over silently.
	 */
	private tryClaim(rec: WatchRecord): boolean {
		const got = this.commit((fileRecs) => {
			const fileRec = fileRecs.get(rec.id);
			const claim = fileRec?.claim;
			if (claim && claim.pid !== this.self().pid && fileRec && this.claimLive(fileRec)) return false;
			rec.claim = this.self();
			fileRecs.set(rec.id, rec);
			return true;
		});
		if (got === undefined) {
			rec.claim = this.self(); // lock trouble: prefer liveness over silence
			return true;
		}
		return got;
	}

	/**
	 * Write OUR records (and unclaimed-new ones); preserve sibling-held records
	 * verbatim — mutate only what you claim. Terminal state always wins, so a
	 * sibling's cancel of one of ours survives.
	 */
	private save(): void {
		this.commit((fileRecs) => {
			for (const rec of this.records.values()) {
				if (this.reaped.has(rec.id)) continue;
				if (!this.isMine(rec)) continue; // sibling's record: keep their copy
				const theirs = fileRecs.get(rec.id);
				if (theirs && theirs.state !== "pending" && rec.state === "pending") continue; // terminal wins
				fileRecs.set(rec.id, rec);
			}
		});
	}

	/** Write exactly one record — for deliberate mutations of a sibling's
	 *  record (cross-session cancel/extend are legal). */
	private persistOne(rec: WatchRecord): void {
		this.commit((fileRecs) => fileRecs.set(rec.id, rec));
	}

	/**
	 * Persist a firing as a claim-checked state transition. Returns false when
	 * another session holds the claim or has already completed the record — its
	 * wake, not ours. This is what makes "the claim holder completes the wait"
	 * deterministic even when a stale holder fires late.
	 */
	private persistFire(rec: WatchRecord): boolean {
		return (
			this.commit((fileRecs) => {
				const fileRec = fileRecs.get(rec.id);
				const foreignClaim = fileRec?.claim && fileRec.claim.pid !== this.self().pid;
				if (fileRec && (fileRec.state !== "pending" || foreignClaim)) {
					// Someone else owns it (or already finished it): adopt their claim
					// so we stop ticking it, and stay silent.
					if (fileRec.claim) rec.claim = fileRec.claim;
					return false;
				}
				fileRecs.set(rec.id, rec);
				return true;
			}) ?? true // lock trouble: deliver rather than lose the wake
		);
	}

	private persist(rec: WatchRecord): void {
		if (this.isMine(rec)) this.save();
		else this.persistOne(rec);
	}

	/**
	 * Re-attach persisted records after a restart. Events that fired while pi
	 * was down are delivered immediately with an explicit verdict; everything
	 * else gets its waiters re-armed.
	 */
	reattachPending(): void {
		this.holdDelivery = true;
		try {
			const rearmed: string[] = [];
			for (const rec of [...this.records.values()]) {
				if (rec.state !== "pending") continue;
				// Sibling session already holds the waiters? Hands off — its wakes,
				// its list row for us. Dead holder's claims fall through to ours.
				if (!this.tryClaim(rec)) continue;
				// Jobs are in-memory: a child-owned record whose job is gone (pi died
				// mid-watch) is inherited by the parent so the monitoring intent
				// survives. Deliberate deaths (close/mode-kill) cancel via cancelOwnedBy
				// before we ever get here, so this only catches restart orphans.
				if (rec.owner.kind === "child" && !this.opts.isChildLive(rec.owner.jobId)) {
					rec.owner = { kind: "parent" };
					rec.label = `${rec.label} (inherited from dead job)`;
				}
				// File triggers re-scan the whole log from scratch: anything that
				// matched while pi was down must fire now, including matches that
				// straddled the shutdown boundary.
				if (rec.trigger?.kind === "file-contains") {
					rec.logOffset = 0;
					this.matchers.delete(rec.id);
				}
				const missed = this.checkTrigger(rec);
				const expired = this.now() >= rec.expiresAt;
				if (expired) {
					this.fire(rec, "watch expired (lifetime cap) while pi was down");
				} else if (missed) {
					this.fire(rec, `fired while pi was down: ${missed}${this.exitArtifactVerdict(rec)}`);
				} else {
					this.arm(rec);
					rearmed.push(`${rec.id} [${rec.label}]`);
				}
			}
			// The model must know its watches exist even when nothing fired:
			// an un-announced pending watch is a job silently dropped on the floor.
			if (rearmed.length > 0) {
				this.queueParent(
					`job_watch: ${rearmed.length} watch(es) re-armed after restart — still waiting: ${rearmed.join(", ")}. Nothing fired while pi was down.`,
					false,
				);
			}
		} finally {
			this.holdDelivery = false;
		}
		this.save();
		this.opts.onStateChange();
	}

	// ─── Registration surface ───────────────────────────────────────────────

	register(owner: WatchOwner, input: WatchInput): { ok: true; id: string } | { ok: false; reason: string } {
		if (this.disposed) return { ok: false, reason: "watch manager is shut down" };
		const pending = [...this.records.values()].filter((r) => r.state === "pending").length;
		if (pending >= MAX_WATCHES) return { ok: false, reason: `Too many watches (max ${MAX_WATCHES}). Cancel one first.` };
		if (!input.trigger && !input.heartbeatMs) {
			return { ok: false, reason: "a watch needs a trigger (pid-exit, file-contains, file-quiet, deadline) or a heartbeat" };
		}
		if (input.heartbeatMs !== undefined && input.heartbeatMs < this.opts.minHeartbeatMs) {
			return {
				ok: false,
				reason: `heartbeat ${input.heartbeatMs}ms below minimum ${this.opts.minHeartbeatMs}ms`,
			};
		}
		if (input.guardPid !== undefined && (!Number.isInteger(input.guardPid) || input.guardPid <= 0)) {
			return { ok: false, reason: `invalid guardPid: ${input.guardPid}` };
		}
		const triggerCheck = this.validateTrigger(input.trigger);
		if (triggerCheck) return { ok: false, reason: triggerCheck };
		const at = this.now();
		const pidStart = input.trigger?.kind === "pid-exit" ? this.opts.procIdentity.startTicks(input.trigger.pid) : undefined;
		const bootId = input.trigger?.kind === "pid-exit" ? this.opts.procIdentity.bootId() : undefined;
		const guardStart = input.guardPid !== undefined ? this.opts.procIdentity.startTicks(input.guardPid) : undefined;
		const guardBootId = input.guardPid !== undefined ? this.opts.procIdentity.bootId() : undefined;
		const lifetimeMs = Math.min(
			(input.lifetimeMinutes !== undefined ? input.lifetimeMinutes * 60_000 : this.opts.defaultLifetimeMs),
			this.opts.maxLifetimeMs,
		);
		const quietSt = input.trigger?.kind === "file-quiet" ? this.fileStat(input.trigger.path) : undefined;
		const rec: WatchRecord = {
			id: "", // minted below, atomically with the write
			claim: this.self(),
			owner,
			cwd: this.opts.cwd,
			label: capReportSummary(input.label ?? this.defaultLabel(input)),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(input.heartbeatMs !== undefined ? { heartbeatMs: input.heartbeatMs } : {}),
			...(input.logPath ? { logPath: input.logPath } : {}),
			...(input.survival ? { survival: input.survival } : {}),
			...(bootId !== undefined ? { bootId } : {}),
			...(pidStart !== undefined ? { procStart: pidStart } : {}),
			...(input.guardPid !== undefined ? { guardPid: input.guardPid } : {}),
			...(guardBootId !== undefined ? { guardBootId } : {}),
			...(guardStart !== undefined ? { guardStart } : {}),
			...(quietSt ? { quietLastSize: quietSt.size, lastGrowthAt: quietSt.mtimeMs } : {}),
			createdAt: at,
			expiresAt: at + lifetimeMs,
			state: "pending",
			logOffset: 0,
		};
		// Ids are minted from the shared store under the lock: `w-<n>`, unique
		// per cwd across concurrent sessions, and short enough to live in a
		// status line. (Session identity is the claim's job, not the id's.)
		const minted = this.commit((fileRecs) => {
			let max = 0;
			for (const key of [...fileRecs.keys(), ...this.records.keys()]) {
				const n = Number(key.replace(/^w-/, ""));
				if (Number.isInteger(n)) max = Math.max(max, n);
			}
			rec.id = `w-${max + 1}`;
			fileRecs.set(rec.id, rec);
			return rec.id;
		});
		if (minted === undefined) {
			// Lock trouble: fall back to a pid-scoped id and persist the usual way.
			rec.id = `w-${this.self().pid}-${++this.counter}`;
			this.save();
		}
		this.records.set(rec.id, rec);
		this.arm(rec);
		this.opts.onStateChange();
		return { ok: true, id: rec.id };
	}

	cancel(id: string, owner?: WatchOwner): { ok: boolean; reason: string } {
		const rec = this.records.get(id);
		if (!rec) return { ok: false, reason: `unknown watch: ${id}` };
		// Ownership isolation: a child may only cancel its own watches.
		if (owner && !sameOwner(rec.owner, owner)) {
			return { ok: false, reason: `${id} is not owned by this ${owner.kind}` };
		}
		if (rec.state !== "pending") return { ok: false, reason: `${id} is already ${rec.state}` };
		rec.state = "cancelled";
		rec.verdict = "cancelled by owner";
		rec.firedAt = this.now();
		this.disarm(rec);
		this.persist(rec);
		this.opts.onStateChange();
		return { ok: true, reason: `cancelled ${id}` };
	}

	/** Extend a pending watch's lifetime (minutes from now); resets the
	 *  pre-expiry warning so it can warn again next round. */
	extend(id: string, lifetimeMinutes: number, owner?: WatchOwner): { ok: boolean; reason: string } {
		const rec = this.records.get(id);
		if (!rec) return { ok: false, reason: `unknown watch: ${id}` };
		if (owner && !sameOwner(rec.owner, owner)) {
			return { ok: false, reason: `${id} is not owned by this ${owner.kind}` };
		}
		if (rec.state !== "pending") return { ok: false, reason: `${id} is already ${rec.state}` };
		if (!(lifetimeMinutes > 0)) return { ok: false, reason: "lifetimeMinutes must be > 0" };
		const ms = Math.min(lifetimeMinutes * 60_000, this.opts.maxLifetimeMs);
		rec.expiresAt = this.now() + ms;
		rec.expiryWarned = false;
		this.persist(rec);
		this.opts.onStateChange();
		return { ok: true, reason: `extended ${id} by ${Math.round(ms / 60_000)}min — now expires ${new Date(rec.expiresAt).toISOString()}` };
	}

	/** Cancel every pending watch owned by a job (job close / mode kill). */
	cancelOwnedBy(jobId: string): number {
		let n = 0;
		for (const rec of this.records.values()) {
			if (rec.state === "pending" && rec.owner.kind === "child" && rec.owner.jobId === jobId) {
				this.cancel(rec.id);
				n++;
			}
		}
		return n;
	}

	list(owner?: WatchOwner): WatchView[] {
		const out: WatchView[] = [];
		for (const rec of this.records.values()) {
			if (owner && !sameOwner(rec.owner, owner)) continue;
			out.push(this.view(rec));
		}
		return out;
	}

	get(id: string): WatchRecord | undefined {
		return this.records.get(id);
	}

	hasPendingForChild(jobId: string): boolean {
		for (const rec of this.records.values()) {
			if (rec.state === "pending" && rec.owner.kind === "child" && rec.owner.jobId === jobId) return true;
		}
		return false;
	}

	pendingCountForChild(jobId: string): number {
		let n = 0;
		for (const rec of this.records.values()) {
			if (rec.state === "pending" && rec.owner.kind === "child" && rec.owner.jobId === jobId) n++;
		}
		return n;
	}

	/** Last `n` lines of the watch's log — SEEK-READ: only trailing bytes are
	 *  read, so a multi-GB log costs the same as a small one. */
	tail(id: string, n = 20): string {
		const rec = this.records.get(id);
		if (!rec) return `unknown watch: ${id}`;
		if (!rec.logPath) return `${id} has no log attached; last line: ${rec.lastLine ?? "(none)"}`;
		try {
			const size = statSync(rec.logPath).size;
			const start = Math.max(0, size - TAIL_READ_BYTES);
			const fd = openSync(rec.logPath, "r");
			let text: string;
			try {
				const len = size - start;
				const buf = Buffer.alloc(len);
				readSync(fd, buf, 0, len, start);
				text = buf.toString("utf-8");
			} finally {
				closeSync(fd);
			}
			const lines = text.split("\n").filter((l) => l.trim().length > 0);
			const shown = size > TAIL_READ_BYTES ? `last ${TAIL_READ_BYTES / 1024}KB of ${rec.logPath}` : `${rec.logPath} (${lines.length} lines)`;
			return [`${id} tail of ${shown}:`, ...lines.slice(-n)].join("\n");
		} catch (err) {
			return `${id}: cannot read ${rec.logPath}: ${err}`;
		}
	}

	/** Deliver deferred parent events (called at turn boundaries, like drain()).
	 *  Each event gets its own send; a boundary-race failure is re-queued for the
	 *  next boundary rather than lost. */
	flushEvents(): void {
		while (this.pendingEvents.length > 0 && this.opts.canDeliver()) {
			const ev = this.pendingEvents[0]!;
			try {
				this.opts.sendParentEvent(ev.text, ev.urgent, ev.display);
				this.pendingEvents.shift();
			} catch {
				break; // retry at the next boundary
			}
		}
	}

	/** Queue a non-urgent notice for the parent model (delivered at a boundary). */
	notify(text: string): void {
		this.queueParent(capBashTail(text), false);
	}

	/** Kill waiters only. Pending records stay in the store for the next session. */
	dispose(): void {
		this.disposed = true;
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = undefined;
		for (const rec of this.records.values()) this.disarm(rec);
	}

	// ─── Waiters ────────────────────────────────────────────────────────────

	/** Arm the shared tick — ONE timer drives triggers, heartbeats and expiry. */
	private arm(rec: WatchRecord): void {
		this.lastBeatAt.set(rec.id, this.now());
		if (this.tickTimer) return;
		this.tickTimer = setInterval(() => this.runTick(), this.opts.pollIntervalMs);
		this.tickTimer.unref?.();
	}

	private disarm(rec: WatchRecord): void {
		this.lastBeatAt.delete(rec.id);
		// The shared tick ignores non-pending records; it stops at dispose().
	}

	private runTick(): void {
		if (this.disposed) return;
		this.reconcile();
		for (const rec of [...this.records.values()]) {
			if (rec.state !== "pending") continue;
			if (!this.isMine(rec)) {
				// Sibling holds it while alive; adopt it the moment the holder dies.
				if (!this.claimLive(rec) && this.tryClaim(rec)) {
					this.arm(rec);
					this.opts.onStateChange();
					this.queueParent(`job_watch: took over ${rec.id} [${rec.label}] — its session ended`, false);
				}
				continue;
			}
			this.tick(rec);
		}
	}

	/** Adopt sibling sessions' updates (their cancels/extends/fires). Cheap:
	 *  one stat per tick; a full read only when the store actually changed. */
	private reconcile(): void {
		try {
			const st = statSync(this.opts.storePath);
			if (st.mtimeMs === this.lastReconcileMtime) return;
			this.lastReconcileMtime = st.mtimeMs;
		} catch {
			return;
		}
		try {
			const fileRecs = this.readFileRecords();
			for (const [id, fileRec] of fileRecs) {
				if (this.reaped.has(id)) continue;
				const mem = this.records.get(id);
				if (!mem) {
					// Sibling's new record: show it in list; the tick loop takes over
					// it only if the holder is dead.
					this.records.set(id, fileRec);
					continue;
				}
				if (fileRec.state !== "pending" && mem.state === "pending") {
					// Someone finished/cancelled it: terminal wins everywhere.
					this.disarm(mem);
					this.records.set(id, fileRec);
					continue;
				}
				if (fileRec.state === "pending" && mem.state === "pending") {
					// Adopt their bookkeeping where it is ahead of ours.
					if (fileRec.expiresAt > mem.expiresAt) mem.expiresAt = fileRec.expiresAt;
					if (fileRec.expiryWarned) mem.expiryWarned = true;
				}
			}
		} catch {
			/* keep running on our in-memory view */
		}
	}

	private tick(rec: WatchRecord): void {
		if (this.disposed || rec.state !== "pending") return;
		// Trigger check FIRST: scanFile advances the offset, so a preview read
		// before the check would eat the bytes the pattern needs to see.
		const hit = this.checkTrigger(rec);
		if (hit) {
			this.fire(rec, hit);
			return;
		}
		if (rec.trigger?.kind !== "file-contains") this.refreshPreview(rec);
		if (rec.heartbeatMs) {
			const last = this.lastBeatAt.get(rec.id) ?? rec.createdAt;
			if (this.now() - last >= rec.heartbeatMs) {
				this.lastBeatAt.set(rec.id, this.now());
				this.beat(rec);
			}
		}
		// Lifetime: ONE pre-expiry warning offering a stay of execution, then the
		// guillotine (a forgotten watch must end; an engaged one extends).
		const lifetime = rec.expiresAt - rec.createdAt;
		if (!rec.expiryWarned && this.now() >= rec.expiresAt - Math.min(5 * 60_000, lifetime * 0.2)) {
			rec.expiryWarned = true;
			this.save();
			const minsLeft = Math.max(1, Math.round((rec.expiresAt - this.now()) / 60_000));
			this.deliver(
				rec,
				`⚠ watch ${rec.id} [${rec.label}] expires in ~${minsLeft}min. Still needed? Extend it: job_watch extend (id=${rec.id}, lifetimeMinutes=…)`,
				true,
				true,
			);
		}
		if (this.now() >= rec.expiresAt) {
			this.fire(rec, "watch expired (lifetime cap)");
		}
	}

	private beat(rec: WatchRecord): void {
		if (this.disposed || rec.state !== "pending") return;
		if (rec.trigger?.kind !== "file-contains") this.refreshPreview(rec);
		const at = new Date(this.now()).toISOString();
		const preview = rec.lastLine ? ` | last: ${rec.lastLine}` : "";
		this.deliver(rec, `watch ${rec.id} heartbeat at ${at} [${rec.label}]${preview}`, true, false);
	}

	// ─── Trigger evaluation ─────────────────────────────────────────────────

	/** Returns a hit description when the trigger condition holds, else null. */
	private checkTrigger(rec: WatchRecord): string | null {
		const t = rec.trigger;
		if (t) {
			switch (t.kind) {
				case "pid-exit": {
					const hit = this.deathVerdict(t.pid, rec.procStart, rec.bootId);
					return hit ? hit : this.guardCheck(rec);
				}
				case "file-contains": {
					const hit = this.scanFile(rec, t);
					return hit ? `pattern '${t.pattern}' found in ${t.path}` : this.guardCheck(rec);
				}
				case "file-quiet": {
					const st = this.fileStat(t.path);
					if (st === undefined) return this.guardCheck(rec); // log not created yet: not silence
					if (st.size !== (rec.quietLastSize ?? st.size)) {
						// It grew — and the growth time is the file's mtime, not "now":
						// writes may have happened while pi was down.
						rec.quietLastSize = st.size;
						rec.lastGrowthAt = st.mtimeMs;
						return this.guardCheck(rec);
					}
					const quietSince = rec.lastGrowthAt ?? rec.createdAt;
					const quietFor = this.now() - quietSince;
					return quietFor >= t.seconds * 1000
						? `no new output in ${t.path} for ${Math.round(quietFor / 1000)}s`
						: this.guardCheck(rec);
				}
				case "deadline": {
					return this.now() >= t.at
						? `deadline ${new Date(t.at).toISOString()} passed`
						: this.guardCheck(rec);
				}
			}
		}
		return this.guardCheck(rec);
	}

	/** The death guard: whatever else a watch waits for, a guarded pid ending
	 *  (exit / reboot / pid reuse) fires it. Death is never silent. */
	private guardCheck(rec: WatchRecord): string | null {
		if (rec.guardPid === undefined) return null;
		const verdict = this.deathVerdict(rec.guardPid, rec.guardStart, rec.guardBootId);
		return verdict ? `guard: ${verdict}` : null;
	}

	/** Death of a pid, with the identity nuance: "gone" vs "reused" vs
	 *  "machine rebooted" are different verdicts. */
	private deathVerdict(pid: number, start: number | undefined, bootId: string | undefined): string | null {
		const s = this.opts.procIdentity.startTicks(pid);
		const alive = s !== undefined || this.opts.procIdentity.alive(pid);
		if (!alive) {
			const boot = this.opts.procIdentity.bootId();
			if (bootId !== undefined && boot !== undefined && boot !== bootId) {
				return `machine rebooted while we were away; pid ${pid} is gone`;
			}
			return `pid ${pid} exited`;
		}
		if (start !== undefined && s !== undefined && s !== start) {
			return `pid ${pid} was reused by an unrelated process — the watched job is gone`;
		}
		return null;
	}

	private validateTrigger(t: WatchTrigger | undefined): string | null {
		if (!t) return null;
		if (t.kind === "pid-exit" && (!Number.isInteger(t.pid) || t.pid <= 0)) return `invalid pid: ${t.pid}`;
		if (t.kind === "file-contains" && (!t.path || !t.pattern)) return "file-contains needs path and pattern";
		if (t.kind === "file-contains") {
			const bad = validatePatternRegex(t.pattern);
			if (bad) return bad;
		}
		if (t.kind === "file-quiet" && (!t.path || !(t.seconds >= 60))) {
			return "file-quiet needs a path and seconds >= 60";
		}
		if (t.kind === "deadline" && typeof t.at !== "number") return "deadline needs an epoch timestamp";
		return null;
	}

	private fileStat(path: string): { size: number; mtimeMs: number } | undefined {
		try {
			const st = statSync(path);
			return { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			return undefined;
		}
	}

	/**
	 * Incrementally scan the log for the pattern and update the preview line.
	 * A shrunk file (rotation) resets the offset. Also used for previews on
	 * watches without a file trigger.
	 */
	private scanFile(rec: WatchRecord, t?: Extract<WatchTrigger, { kind: "file-contains" }>): boolean {
		const path = t?.path ?? rec.logPath;
		if (!path) return false;
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			return false;
		}
		let hit = false;
		try {
			const fd = openSync(path, "r");
			try {
				if (size < rec.logOffset) {
					// Truncated/rotated: start over.
					rec.logOffset = 0;
					this.matcherFor(rec, t)?.reset();
				}
				const len = size - rec.logOffset;
				if (len > 0) {
					const buf = Buffer.alloc(len);
					readSync(fd, buf, 0, len, rec.logOffset);
					rec.logOffset = size;
					// IncrementalMatcher holds the re-scan window AND multibyte state:
					// matches split across reads (or chars split across polls) survive.
					const { text, hit: h } = this.matcherFor(rec, t)!.feed(buf);
					if (h) hit = true;
					const lines = text.split("\n").filter((l) => l.trim().length > 0);
					if (lines.length > 0) rec.lastLine = lines[lines.length - 1]!.slice(0, LAST_LINE_MAX);
				}
			} finally {
				closeSync(fd);
			}
		} catch {
			/* unreadable log: treat as no hit this tick */
		}
		return hit;
	}

	/** Per-record streaming matcher (pattern fixed at register time). */
	private matcherFor(rec: WatchRecord, t?: Extract<WatchTrigger, { kind: "file-contains" }>): IncrementalMatcher {
		let m = this.matchers.get(rec.id);
		if (!m) {
			m = new IncrementalMatcher(t?.pattern);
			this.matchers.set(rec.id, m);
		}
		return m;
	}

	private refreshPreview(rec: WatchRecord): void {
		if (rec.logPath) this.scanFile(rec);
	}

	/** Down-time verdict for `watch run` jobs: did it end cleanly while we were down? */
	private exitArtifactVerdict(rec: WatchRecord): string {
		if (!rec.logPath) return "";
		try {
			const text = readFileSync(rec.logPath, "utf-8");
			const idx = text.lastIndexOf(WATCH_EXIT_MARKER);
			if (idx >= 0) {
				const code = text.slice(idx + WATCH_EXIT_MARKER.length).split("\n")[0]?.trim() ?? "?";
				return ` (exit artifact present: exit ${code})`;
			}
		} catch {
			/* fall through */
		}
		return " (no exit artifact — the job may have been killed; check the log)";
	}

	// ─── Delivery ───────────────────────────────────────────────────────────

	private fire(rec: WatchRecord, verdict: string): void {
		if (rec.state !== "pending") return;
		this.refreshPreview(rec); // fresh last line for the event payload
		rec.state = "fired";
		rec.firedAt = this.now();
		rec.verdict = verdict;
		this.disarm(rec);
		// Claim-checked transition: a stale holder stays silent when another
		// session holds the claim or already completed the record.
		if (!this.persistFire(rec)) return;
		const at = new Date(rec.firedAt).toISOString();
		const preview = rec.lastLine ? `\nlast: ${rec.lastLine}` : "";
		// pid-exit alone cannot say clean-exit vs killed; the exit artifact can.
		const artifact = rec.trigger?.kind === "pid-exit" ? this.exitArtifactVerdict(rec) : "";
		this.opts.onStateChange();
		this.deliver(rec, `watch ${rec.id} fired at ${at} [${rec.label}]: ${verdict}${artifact}${preview}`, true, true);
	}

	/**
	 * Route an event to its owner. Child-owned events resume the child; if the
	 * job is gone (closed, or a restart orphaned it) the parent hears instead.
	 * Parent events defer while the parent is busy/compacting.
	 */
	private deliver(rec: WatchRecord, text: string, urgent: boolean, display: boolean): void {
		const capped = capBashTail(text);
		if (rec.owner.kind === "child") {
			if (!this.opts.resumeChild(rec.owner.jobId, capped)) {
				this.queueParent(`${capped}\n(owner job ${rec.owner.jobId} is gone; acting on its behalf)`, true, display);
			}
			return;
		}
		this.queueParent(capped, urgent, display);
	}

	private queueParent(text: string, urgent: boolean, display = true): void {
		if (!this.holdDelivery && this.opts.canDeliver()) {
			try {
				this.opts.sendParentEvent(text, urgent, display);
				return;
			} catch {
				// A send can fail at session boundaries (e.g. before the first turn);
				// hold the event and let flushEvents() retry at the next boundary.
			}
		}
		this.pendingEvents.push({ text, urgent, display });
	}

	private defaultLabel(input: WatchInput): string {
		const t = input.trigger;
		if (!t) return `heartbeat every ${Math.round((input.heartbeatMs ?? 0) / 1000)}s`;
		switch (t.kind) {
			case "pid-exit": return `pid ${t.pid} exits`;
			case "file-contains": return `'${t.pattern}' in ${t.path}`;
			case "file-quiet": return `silence in ${t.path} (${t.seconds}s)`;
			case "deadline": return `deadline ${new Date(t.at).toISOString()}`;
		}
	}

	private view(rec: WatchRecord): WatchView {
		return {
			id: rec.id,
			owner: rec.owner,
			label: rec.label,
			state: rec.state,
			...(rec.trigger ? { trigger: rec.trigger } : {}),
			...(rec.heartbeatMs !== undefined ? { heartbeatMs: rec.heartbeatMs } : {}),
			...(rec.logPath ? { logPath: rec.logPath } : {}),
			createdAt: rec.createdAt,
			expiresAt: rec.expiresAt,
			...(rec.firedAt !== undefined ? { firedAt: rec.firedAt } : {}),
			...(rec.verdict !== undefined ? { verdict: rec.verdict } : {}),
			...(rec.lastLine !== undefined ? { lastLine: rec.lastLine } : {}),
			...(rec.survival !== undefined ? { survival: rec.survival } : {}),
			...(rec.guardPid !== undefined ? { guardPid: rec.guardPid } : {}),
			...(rec.claim && rec.claim.pid !== this.self().pid ? { claimedBy: rec.claim.pid } : {}),
		};
	}
}

/**
 * Human-facing status chip: what is being waited on and who holds it
 * (`w-2@s200` = a sibling session owns the waiters). Undefined when nothing
 * is pending — the footer reverts to silence.
 */
export function formatWatchChip(views: WatchView[]): string | undefined {
	const pending = views.filter((v) => v.state === "pending");
	if (pending.length === 0) return undefined;
	const items = pending.slice(0, 3).map((v) => {
		const label = v.label.length > 32 ? `${v.label.slice(0, 31)}…` : v.label;
		return `${v.id}${v.claimedBy !== undefined ? `@s${v.claimedBy}` : ""}: ${label}`;
	});
	const more = pending.length > 3 ? ` +${pending.length - 3}` : "";
	return `⏱ ${pending.length} waiting: ${items.join(", ")}${more}`;
}

function sameOwner(a: WatchOwner, b: WatchOwner): boolean {
	if (a.kind === "parent" && b.kind === "parent") return true;
	return a.kind === "child" && b.kind === "child" && a.jobId === b.jobId;
}

/** Kernel/process identity probes — injectable so tests can fake reboots and
 *  pid reuse without owning the machine. */
export interface ProcIdentity {
	bootId(): string | undefined;
	startTicks(pid: number): number | undefined;
	/** Portable liveness (signal 0): covers platforms where /proc is absent and
	 *  start ticks are unreadable — better "alive but unidentifiable" than a
	 *  false "exited". */
	alive(pid: number): boolean;
}

export const realProcIdentity: ProcIdentity = {
	bootId: readBootId,
	startTicks: (pid) => readProcStat(pid).start,
	alive(pid) {
		if (readProcStat(pid).start !== undefined) return true;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
};

