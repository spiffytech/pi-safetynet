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
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { WatchInput, WatchOwner, WatchTrigger, WatchView } from "pi-submarine-core";
import { capReportSummary, capBashTail } from "pi-submarine-core";

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
	/** Byte offset into logPath already scanned for the pattern/preview. */
	logOffset: number;
	lastLine?: string;
}

export interface WatchManagerOptions {
	/** Where records persist. One store per cwd, so adoption is automatic. */
	storePath: string;
	cwd: string;
	/** Smallest allowed heartbeat (guards against wake spam). */
	minHeartbeatMs?: number;
	/** Trigger polling interval. */
	pollIntervalMs?: number;
	/** Hard lifetime cap per record. */
	maxLifetimeMs?: number;
	now?: () => number;
	/** Deliver an event to the parent session (urgent = triggers a turn). */
	sendParentEvent(text: string, urgent: boolean): void;
	/** Resume a child job with an event. Returns false when the job is gone. */
	resumeChild(jobId: string, text: string): boolean;
	/** Whether a child job is still live (restart-orphan detection at reattach). */
	isChildLive?(jobId: string): boolean;
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
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60_000;
const LAST_LINE_MAX = 200;
const STORE_VERSION = 1;
/** Exit artifact appended by `watch run`'s wrapper, used for down-time verdicts. */
export const WATCH_EXIT_MARKER = "__WATCH_EXIT=";

/** Store path for a cwd: one JSON file per working directory. */
export function watchStorePath(agentDir: string, cwd: string): string {
	const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(agentDir, "pi-submarine", `watches-${key}.json`);
}

export class WatchManager {
	private readonly opts: Required<Omit<WatchManagerOptions, "now" | "canDeliver" | "isChildLive">> & {
		now: () => number;
		canDeliver: () => boolean;
		isChildLive: (jobId: string) => boolean;
	};
	private readonly records = new Map<string, WatchRecord>();
	private readonly pollTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly beatTimers = new Map<string, ReturnType<typeof setInterval>>();
	private readonly pendingEvents: Array<{ text: string; urgent: boolean }> = [];
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
			maxLifetimeMs: options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
			now: options.now ?? (() => Date.now()),
			sendParentEvent: options.sendParentEvent,
			resumeChild: options.resumeChild,
			isChildLive: options.isChildLive ?? (() => false),
			canDeliver: options.canDeliver ?? (() => true),
		};
		this.load();
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
		} catch {
			/* corrupt store: start clean rather than refuse to run */
		}
	}

	private save(): void {
		try {
			mkdirSync(dirname(this.opts.storePath), { recursive: true });
			const tmp = `${this.opts.storePath}.tmp`;
			writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, records: [...this.records.values()] }, null, 2));
			renameSync(tmp, this.opts.storePath);
		} catch {
			/* persistence is best-effort; the live waiters still work */
		}
	}

	/**
	 * Re-attach persisted records after a restart. Events that fired while pi
	 * was down are delivered immediately with an explicit verdict; everything
	 * else gets its waiters re-armed.
	 */
	reattachPending(): void {
		this.holdDelivery = true;
		try {
			for (const rec of [...this.records.values()]) {
				if (rec.state !== "pending") continue;
				// Jobs are in-memory: a child-owned record whose job is gone (pi died
				// mid-watch) is inherited by the parent so the monitoring intent
				// survives. Deliberate deaths (close/mode-kill) cancel via cancelOwnedBy
				// before we ever get here, so this only catches restart orphans.
				if (rec.owner.kind === "child" && !this.opts.isChildLive(rec.owner.jobId)) {
					rec.owner = { kind: "parent" };
					rec.label = `${rec.label} (inherited from dead job)`;
				}
				const missed = this.checkTrigger(rec);
				const expired = this.now() >= rec.expiresAt;
				if (expired) {
					this.fire(rec, "watch expired (lifetime cap) while pi was down");
				} else if (missed) {
					this.fire(rec, `fired while pi was down: ${missed}${this.exitArtifactVerdict(rec)}`);
				} else {
					this.arm(rec);
				}
			}
		} finally {
			this.holdDelivery = false;
		}
		this.save();
	}

	// ─── Registration surface ───────────────────────────────────────────────

	register(owner: WatchOwner, input: WatchInput): { ok: true; id: string } | { ok: false; reason: string } {
		if (this.disposed) return { ok: false, reason: "watch manager is shut down" };
		if (!input.trigger && !input.heartbeatMs) {
			return { ok: false, reason: "a watch needs a trigger (pid-exit, file-contains, deadline) or a heartbeat" };
		}
		if (input.heartbeatMs !== undefined && input.heartbeatMs < this.opts.minHeartbeatMs) {
			return {
				ok: false,
				reason: `heartbeat ${input.heartbeatMs}ms below minimum ${this.opts.minHeartbeatMs}ms`,
			};
		}
		const triggerCheck = this.validateTrigger(input.trigger);
		if (triggerCheck) return { ok: false, reason: triggerCheck };
		const at = this.now();
		const rec: WatchRecord = {
			id: `w-${++this.counter}`,
			owner,
			cwd: this.opts.cwd,
			label: capReportSummary(input.label ?? this.defaultLabel(input)),
			...(input.trigger ? { trigger: input.trigger } : {}),
			...(input.heartbeatMs !== undefined ? { heartbeatMs: input.heartbeatMs } : {}),
			...(input.logPath ? { logPath: input.logPath } : {}),
			createdAt: at,
			expiresAt: at + this.opts.maxLifetimeMs,
			state: "pending",
			logOffset: 0,
		};
		this.records.set(rec.id, rec);
		this.arm(rec);
		this.save();
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
		this.save();
		return { ok: true, reason: `cancelled ${id}` };
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

	/** Last `n` lines of the watch's log (the pull half of the wake payload). */
	tail(id: string, n = 20): string {
		const rec = this.records.get(id);
		if (!rec) return `unknown watch: ${id}`;
		if (!rec.logPath) return `${id} has no log attached; last line: ${rec.lastLine ?? "(none)"}`;
		try {
			const buf = readFileSync(rec.logPath, "utf-8");
			const lines = buf.split("\n").filter((l) => l.trim().length > 0);
			const head = `${id} tail of ${rec.logPath} (${lines.length} lines):`;
			return [head, ...lines.slice(-n)].join("\n");
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
				this.opts.sendParentEvent(ev.text, ev.urgent);
				this.pendingEvents.shift();
			} catch {
				break; // retry at the next boundary
			}
		}
	}

	/** Kill waiters only. Pending records stay in the store for the next session. */
	dispose(): void {
		this.disposed = true;
		for (const rec of this.records.values()) this.disarm(rec);
	}

	// ─── Waiters ────────────────────────────────────────────────────────────

	private arm(rec: WatchRecord): void {
		this.disarm(rec);
		const poll = setInterval(() => this.tick(rec), this.opts.pollIntervalMs);
		poll.unref?.();
		this.pollTimers.set(rec.id, poll);
		if (rec.heartbeatMs) {
			const beat = setInterval(() => this.beat(rec), rec.heartbeatMs);
			beat.unref?.();
			this.beatTimers.set(rec.id, beat);
		}
	}

	private disarm(rec: WatchRecord): void {
		const poll = this.pollTimers.get(rec.id);
		if (poll) clearInterval(poll);
		const beat = this.beatTimers.get(rec.id);
		if (beat) clearInterval(beat);
		this.pollTimers.delete(rec.id);
		this.beatTimers.delete(rec.id);
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
		if (this.now() >= rec.expiresAt) {
			this.fire(rec, "watch expired (lifetime cap)");
		}
	}

	private beat(rec: WatchRecord): void {
		if (this.disposed || rec.state !== "pending") return;
		if (rec.trigger?.kind !== "file-contains") this.refreshPreview(rec);
		const at = new Date(this.now()).toISOString();
		const preview = rec.lastLine ? ` | last: ${rec.lastLine}` : "";
		this.deliver(rec, `watch ${rec.id} heartbeat at ${at} [${rec.label}]${preview}`, true);
	}

	// ─── Trigger evaluation ─────────────────────────────────────────────────

	/** Returns a hit description when the trigger condition holds, else null. */
	private checkTrigger(rec: WatchRecord): string | null {
		const t = rec.trigger;
		if (!t) return null;
		switch (t.kind) {
			case "pid-exit": {
				if (!pidAlive(t.pid)) return `pid ${t.pid} exited`;
				return null;
			}
			case "file-contains": {
				const hit = this.scanFile(rec, t);
				return hit ? `pattern '${t.pattern}' found in ${t.path}` : null;
			}
			case "deadline": {
				return this.now() >= t.at ? `deadline ${new Date(t.at).toISOString()} passed` : null;
			}
		}
	}

	private validateTrigger(t: WatchTrigger | undefined): string | null {
		if (!t) return null;
		if (t.kind === "pid-exit" && (!Number.isInteger(t.pid) || t.pid <= 0)) return `invalid pid: ${t.pid}`;
		if (t.kind === "file-contains" && (!t.path || !t.pattern)) return "file-contains needs path and pattern";
		if (t.kind === "deadline" && typeof t.at !== "number") return "deadline needs an epoch timestamp";
		return null;
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
				if (size < rec.logOffset) rec.logOffset = 0;
				const len = size - rec.logOffset;
				if (len > 0) {
					const buf = Buffer.alloc(len);
					readSync(fd, buf, 0, len, rec.logOffset);
					const text = buf.toString("utf-8");
					rec.logOffset = size;
					if (t && text.includes(t.pattern)) hit = true;
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
		this.save();
		const at = new Date(rec.firedAt).toISOString();
		const preview = rec.lastLine ? `\nlast: ${rec.lastLine}` : "";
		// pid-exit alone cannot say clean-exit vs killed; the exit artifact can.
		const artifact = rec.trigger?.kind === "pid-exit" ? this.exitArtifactVerdict(rec) : "";
		this.deliver(rec, `watch ${rec.id} fired at ${at} [${rec.label}]: ${verdict}${artifact}${preview}`, true);
	}

	/**
	 * Route an event to its owner. Child-owned events resume the child; if the
	 * job is gone (closed, or a restart orphaned it) the parent hears instead.
	 * Parent events defer while the parent is busy/compacting.
	 */
	private deliver(rec: WatchRecord, text: string, urgent: boolean): void {
		const capped = capBashTail(text);
		if (rec.owner.kind === "child") {
			if (!this.opts.resumeChild(rec.owner.jobId, capped)) {
				this.queueParent(`${capped}\n(owner job ${rec.owner.jobId} is gone; acting on its behalf)`, true);
			}
			return;
		}
		this.queueParent(capped, urgent);
	}

	private queueParent(text: string, urgent: boolean): void {
		if (!this.holdDelivery && this.opts.canDeliver()) {
			try {
				this.opts.sendParentEvent(text, urgent);
				return;
			} catch {
				// A send can fail at session boundaries (e.g. before the first turn);
				// hold the event and let flushEvents() retry at the next boundary.
			}
		}
		this.pendingEvents.push({ text, urgent });
	}

	private defaultLabel(input: WatchInput): string {
		const t = input.trigger;
		if (!t) return `heartbeat every ${Math.round((input.heartbeatMs ?? 0) / 1000)}s`;
		switch (t.kind) {
			case "pid-exit": return `pid ${t.pid} exits`;
			case "file-contains": return `'${t.pattern}' in ${t.path}`;
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
		};
	}
}

function sameOwner(a: WatchOwner, b: WatchOwner): boolean {
	if (a.kind === "parent" && b.kind === "parent") return true;
	return a.kind === "child" && b.kind === "child" && a.jobId === b.jobId;
}

/** Node-only liveness check. PID reuse in the poll window is accepted risk. */
function pidAlive(pid: number): boolean {
	return existsSync(`/proc/${pid}`);
}