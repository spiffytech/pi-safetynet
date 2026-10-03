/**
 * subagent-jobs.ts — registry, lifecycle, reports, and wake scheduling for
 * persistent two-way subagents.
 *
 * Deliberately dependency-injected (runner + parent transport) so it can be
 * unit-tested without a live pi session. Nothing here reads a child's session
 * or transcript; the only child-internal data exposed upward is the current
 * bash call's output tail, which the runner records explicitly.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { accumulateUsage, isZeroUsage, snapshotUsage, subtractUsage, zeroUsage } from "pi-submarine-core";
import { capBashTail, capReportMessage, capReportSummary } from "pi-submarine-core";

export type JobState = "starting" | "running" | "idle" | "closed" | "failed";

/** Why a segment ended. A timeout abort is surfaced distinctly from a
 *  natural end so the parent is never told "idle" about killed work. */
export interface IdleReason {
	kind: "completed" | "timeout";
	/** Set by the job manager when the segment settles. */
	at?: number;
	/** The in-flight bash command when a timeout abort cut the segment. */
	command?: string;
	/** Cap that fired, for the status label. */
	durationMs?: number;
}

/** Resumes without a child report before the parent is warned. */
export const WATCH_RESUME_ESCALATION = 3;

/** Per-segment reporting bookkeeping shared with the child extension. */
export interface SegmentState {
	reported: boolean;
	nudged: boolean;
}

export interface JobReport {
	id: string;
	summary: string;
	body: string;
	urgent: boolean;
	delivered: boolean;
	at: number;
}

export interface BashSnapshot {
	command: string;
	tail: string;
	at: number;
}

export interface JobControls {
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): void;
}

export interface SubagentJob {
	id: string;
	prompt: string;
	cwd: string;
	spawnMode: string;
	state: JobState;
	startedAt: number;
	idleAt?: number;
	idleReason?: IdleReason;
	/** Idle with pending owned watches: the child is waiting, not done. */
	waiting?: boolean;
	controls?: JobControls;
	segment: SegmentState;
	reports: JobReport[];
	bash?: BashSnapshot;
	usage: Usage;
	usageDelivered: Usage;
	closed: boolean;
	/** Child resumes driven by watch events since the last child report. */
	resumesSinceReport: number;
	resumeEscalated: boolean;
}

/** Bounded projection handed to the parent. Never transcript or raw results. */
export interface JobStatus {
	id: string;
	state: JobState;
	prompt: string;
	spawnMode: string;
	startedAt: number;
	idleAt?: number;
	idleReason?: IdleReason;
	waiting: boolean;
	reported: boolean;
	usage: Usage;
	lastReport?: { summary: string; body: string; at: number };
	bash?: { command: string; tail: string };
}

export const MAX_LIVE_JOBS = 8;
export const REPORT_DEBOUNCE_MS = 250;
/** First retry backoff after a transient send failure (× attempt, capped). */
export const REPORT_RETRY_MS = 1000;
export const REPORT_RETRY_MAX_MS = 5000;
export const MAX_REPORT_RETRIES = 5;
export const REPORT_CUSTOM_TYPE = "safetynet:subagent-report";
export const WAKE_CUSTOM_TYPE = "safetynet:subagent-done";

export interface JobManagerDeps {
	/** Deliver text to the PARENT model. `urgent: true` triggers a turn. */
	sendToParent(text: string, opts: { urgent: boolean; jobId: string }): void;
	/** Whether the parent is currently compacting (wakes are deferred). */
	isCompacting(): boolean;
	/** Whether the parent is mid-turn. Wakes/reports are deferred to the turn boundary
	 *  so a message can never be queued behind a turn and outlive its job. */
	isParentBusy?(): boolean;
	/** Whether a job has pending owned watches (a waiting child is not done). */
	hasPendingWatches?(jobId: string): boolean;
	/** A job ended for good: cancel its owned watches (watches die with owners). */
	onJobClosed?(jobId: string): void;
	now?(): number;
}

export class SubagentJobManager {
	private readonly jobs = new Map<string, SubagentJob>();
	private readonly deps: JobManagerDeps;
	private counter = 0;
	private disposed = false;
	private reportTimer: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private reportAttempts = 0;
	private pendingReports: Array<{ job: SubagentJob; report: JobReport }> = [];
	private wakeTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingWake: Set<string> = new Set();
	private wakeDeferred = false;

	constructor(deps: JobManagerDeps) {
		this.deps = deps;
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	/** All live (non-closed) jobs. */
	list(): SubagentJob[] {
		return [...this.jobs.values()].filter((j) => !j.closed);
	}

	get(id: string): SubagentJob | undefined {
		return this.jobs.get(id);
	}

	liveCount(): number {
		// Failed is terminal — it must not hold a cap slot (nothing auto-closes it).
		return this.list().filter((j) => j.state !== "failed").length;
	}

	/** Create and register a job synchronously (before any await) so cap checks are atomic. */
	create(opts: { prompt: string; cwd: string; spawnMode: string }): SubagentJob {
		if (this.liveCount() >= MAX_LIVE_JOBS) {
			const open = this.list().map((j) => j.id).join(", ");
			throw new Error(`Too many live subagents (max ${MAX_LIVE_JOBS}). Close one first: ${open}`);
		}
		const id = `sub-${++this.counter}`;
		const job: SubagentJob = {
			id,
			prompt: opts.prompt,
			cwd: opts.cwd,
			spawnMode: opts.spawnMode,
			state: "starting",
			startedAt: this.now(),
			segment: { reported: false, nudged: false },
			reports: [],
			usage: zeroUsage(),
			usageDelivered: zeroUsage(),
			closed: false,
			resumesSinceReport: 0,
			resumeEscalated: false,
		};
		this.jobs.set(id, job);
		return job;
	}

	setControls(id: string, controls: JobControls): void {
		const job = this.jobs.get(id);
		if (!job) return;
		job.controls = controls;
		if (!job.closed && job.state === "starting") job.state = "running";
	}

	/** Reset per-segment reporting state before each work segment. */
	beginSegment(id: string): void {
		const job = this.jobs.get(id);
		if (!job) return;
		job.segment.reported = false;
		job.segment.nudged = false;
		job.state = "running";
	}

	recordBash(id: string, command: string, tail: string): void {
		const job = this.jobs.get(id);
		if (!job || job.closed) return;
		job.bash = { command: capReportSummary(command), tail: capBashTail(tail), at: this.now() };
	}

	addUsage(id: string, usage: Usage): void {
		const job = this.jobs.get(id);
		if (!job || job.closed) return;
		accumulateUsage(job.usage, usage);
	}

	/** A work segment finished normally or was aborted by the segment timeout. */
	idle(id: string, reason?: IdleReason): void {
		const job = this.jobs.get(id);
		if (!job || job.closed || job.state === "closed" || job.state === "failed") return;
		job.state = "idle";
		job.idleAt = this.now();
		job.idleReason = { at: job.idleAt, ...(reason ?? { kind: "completed" }) };
		// A killed segment rides a report so the parent can never mistake an abort
		// for a natural end: the label is pullable via status and push-delivered.
		if (job.idleReason.kind === "timeout") {
			const secs = Math.round((job.idleReason.durationMs ?? 0) / 1000);
			const cmd = job.idleReason.command ?? "(unknown command)";
			this.submitReport(id, {
				summary: `Segment aborted after ${secs}s while running: ${cmd}`,
				body: "The segment timeout cut this turn mid-command. The command did not finish; re-run or re-steer if it matters.",
			});
		}
		// A child waiting on its own watches is not done: no parent wake until the
		// watches fire (or the child finishes with none pending). Ambiguity wakes.
		job.waiting = this.deps.hasPendingWatches?.(id) ?? false;
		this.flushPendingReports();
		if (!job.waiting) this.scheduleWake(id);
	}

	/** A watch event resumed this child. Counts toward escalation when reports
	 *  never follow; resets whenever the child actually reports. */
	noteWatchResume(id: string): void {
		const job = this.jobs.get(id);
		if (!job || job.closed) return;
		job.resumesSinceReport++;
		if (job.resumesSinceReport >= WATCH_RESUME_ESCALATION && !job.resumeEscalated) {
			this.submitReport(id, {
				summary: `Watch-driven: child resumed ${job.resumesSinceReport}x without reporting`,
				body: "A subagent is being resumed by watch events and keeps ending its turn without a report_to_parent. It may be stuck in a wait-check loop.",
				urgent: true,
			});
			// Set after submitReport: the report resets per-report bookkeeping, and
			// this latch must survive its own escalation until a REAL child report.
			job.resumeEscalated = true;
		}
	}

	/** A work segment or session creation failed. */
	fail(id: string, error: string): void {
		const job = this.jobs.get(id);
		if (!job || job.closed) return;
		job.state = "failed";
		// The urgent report itself wakes the parent; a separate idle wake would
		// mislabel a failed job as idle and double-notify.
		this.submitReport(id, { summary: `Subagent failed: ${error}`, urgent: true });
	}

	/** Submit a child report (non-urgent is debounced; urgent wakes immediately). */
	submitReport(id: string, input: { summary: string; body?: string; urgent?: boolean }): void {
		const job = this.jobs.get(id);
		if (!job || job.closed) return;
		job.segment.reported = true;
		job.resumesSinceReport = 0;
		job.resumeEscalated = false;
		const report: JobReport = {
			id: `${id}-r${job.reports.length + 1}`,
			summary: input.summary,
			body: input.body ?? "",
			urgent: input.urgent === true,
			delivered: false,
			at: this.now(),
		};
		job.reports.push(report);

		if (report.urgent) {
			this.deliver([{ job, report }], true);
			return;
		}
		this.pendingReports.push({ job, report });
		if (!this.reportTimer) {
			// Leading edge: the first report in a burst goes now, the rest coalesce.
			this.flushPendingReports();
			this.reportTimer = setTimeout(() => {
				this.reportTimer = undefined;
				this.flushPendingReports();
			}, REPORT_DEBOUNCE_MS);
		}
	}

	private flushPendingReports(): void {
		if (this.pendingReports.length === 0) return;
		const batch = this.pendingReports;
		this.pendingReports = [];
		// Preserve urgency across a compaction deferral: a report submitted urgent
		// must still wake the parent when the flush finally runs.
		this.deliver(batch, batch.some((item) => item.report.urgent));
	}

	private deliver(batch: Array<{ job: SubagentJob; report: JobReport }>, urgent: boolean): void {
		if (batch.length === 0) return;
		if (this.disposed || this.deps.isCompacting() || this.deps.isParentBusy?.()) {
			// Keep undelivered; delivery is retried on the next report/idle/drain.
			for (const item of batch) item.report.delivered = false;
			this.pendingReports.unshift(...batch);
			return;
		}
		const text = batch
			.map(({ job, report }) => {
				const head = `[${job.id}] ${report.summary}`;
				return report.body ? `${head}\n${report.body}` : head;
			})
			.join("\n\n---\n\n");
		try {
			this.deps.sendToParent(text, { urgent, jobId: batch[0]!.job.id });
			for (const item of batch) item.report.delivered = true;
			this.reportAttempts = 0;
		} catch {
			for (const item of batch) item.report.delivered = false;
			this.pendingReports.unshift(...batch);
			this.scheduleReportRetry();
		}
	}

	/** Bounded backoff retry so a transient send failure lands without waiting for an event. */
	private scheduleReportRetry(): void {
		if (this.retryTimer || this.reportAttempts >= MAX_REPORT_RETRIES) return;
		this.reportAttempts++;
		const backoff = Math.min(REPORT_RETRY_MS * this.reportAttempts, REPORT_RETRY_MAX_MS);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.flushPendingReports();
		}, backoff);
	}

	/** Pull a job's undelivered reports, marking them delivered atomically so a
	 *  subsequent push does not repeat them. */
	takeUndeliveredReports(id: string): JobReport[] {
		const job = this.jobs.get(id);
		if (!job) return [];
		const out = job.reports.filter((r) => !r.delivered);
		if (out.length === 0) return [];
		const ids = new Set(out.map((r) => r.id));
		this.pendingReports = this.pendingReports.filter((p) => !ids.has(p.report.id));
		for (const r of out) r.delivered = true;
		this.clearEmptyTimers();
		return out;
	}

	private scheduleWake(id: string): void {
		this.pendingWake.add(id);
		if (this.wakeTimer) return;
		this.wakeTimer = setTimeout(() => {
			this.wakeTimer = undefined;
			this.flushWake();
		}, REPORT_DEBOUNCE_MS);
	}

	/** Deliver deferred/queued wakes (called after compaction clears). */
	flushWake(): void {
		if (this.pendingWake.size === 0) return;
		if (this.disposed || this.deps.isCompacting() || this.deps.isParentBusy?.()) {
			this.wakeDeferred = true;
			return;
		}
		this.wakeDeferred = false;
		const live = [...this.pendingWake].filter((id) => {
			const job = this.jobs.get(id);
			return job && !job.closed && job.state !== "failed";
		});
		this.pendingWake.clear();
		if (live.length === 0) return;
		// Contentless by design: the wake is a pull trigger, not a payload. Naming
		// jobs here would embed state that can go stale before delivery — the live
		// set is derived at read time by subagent_status.
		try {
			this.deps.sendToParent("Background subagents changed state. Call subagent_status.", {
				urgent: true,
				jobId: live[0]!,
			});
		} catch {
			for (const id of live) this.pendingWake.add(id);
		}
	}

	/** The parent is ready again (turn ended / compaction finished) — deliver anything held back. */
	drain(): void {
		this.flushPendingReports();
		if (this.wakeDeferred) this.flushWake();
	}

	/** Abort + remove a job. Returns the final usage if not yet delivered. */
	/** Abort + remove a job. Returns the final usage if not yet delivered.
	 *  `discard` drops undelivered reports (session teardown) instead of flushing. */
	close(id: string, reason = "closed", discard = false): Usage | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		job.closed = true;
		job.state = "closed";
		this.pendingWake.delete(id);
		// Never discard undelivered content while the session is alive: flush this
		// job's undelivered reports now (urgent) instead of dropping them. Session
		// teardown, though, is a hard cut — the old session's reports would land in
		// the new one, so there they are dropped deterministically.
		const undelivered = job.reports.filter((r) => !r.delivered);
		if (undelivered.length > 0 && !discard) {
			const ids = new Set(undelivered.map((r) => r.id));
			this.pendingReports = this.pendingReports.filter((p) => !ids.has(p.report.id));
			this.deliver(
				undelivered.map((report) => ({ job, report })),
				true,
			);
		}
		this.clearEmptyTimers();
		try {
			job.controls?.abort();
		} catch {
			/* best effort */
		}
		this.jobs.delete(id);
		this.deps.onJobClosed?.(id);
		return this.deliverUsage(job);
	}

	closeAll(discard = false): void {
		for (const id of [...this.jobs.keys()]) this.close(id, "session ended", discard);
		this.cancelTimers();
	}

	/** Kill every live job spawned under a different mode. */
	killByMode(currentMode: string): void {
		for (const job of this.list()) {
			if (job.spawnMode !== currentMode) this.close(job.id, "mode changed");
		}
	}

	/** Return the undelivered usage delta once, remembering what has been emitted. */
	deliverUsage(job: SubagentJob): Usage | undefined {
		const delta = subtractUsage(job.usage, job.usageDelivered);
		if (isZeroUsage(delta)) return undefined;
		job.usageDelivered = snapshotUsage(job.usage);
		return delta;
	}

	status(id: string): JobStatus | undefined {
		const job = this.jobs.get(id) ?? undefined;
		if (!job) return undefined;
		const last = job.reports[job.reports.length - 1];
		return {
			id: job.id,
			state: job.state,
			prompt: capReportMessage(job.prompt),
			spawnMode: job.spawnMode,
			startedAt: job.startedAt,
			usage: job.usage,
			waiting: job.waiting ?? false,
			...(job.idleAt !== undefined ? { idleAt: job.idleAt } : {}),
			...(job.idleReason !== undefined ? { idleReason: job.idleReason } : {}),
			reported: job.segment.reported,
			...(last ? { lastReport: { summary: last.summary, body: last.body, at: last.at } } : {}),
			...(job.bash ? { bash: { command: job.bash.command, tail: job.bash.tail } } : {}),
		};
	}

	allStatuses(): JobStatus[] {
		return this.list().map((j) => this.status(j.id)!);
	}

	/** Reset per-session state. Called on session_start. */
	resetForSession(): void {
		// Abort and dispose live child sessions first — otherwise a session switch
		// orphans them (still running, still spending) and their stale callbacks
		// target ids we are about to reuse. Reports are dropped, not flushed: a
		// session switch is a hard cut and the old session's reports must not leak
		// into the new one.
		this.closeAll(true);
		this.pendingReports = [];
		this.pendingWake.clear();
		this.wakeDeferred = false;
		this.disposed = false;
		// The id counter is intentionally NOT reset: a recycled id could collide
		// with a callback from a child that has not finished tearing down.
	}

	/** Finalize on session_shutdown. */
	dispose(): void {
		this.disposed = true;
		this.closeAll(true);
		this.cancelTimers();
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	private cancelTimers(): void {
		if (this.reportTimer) clearTimeout(this.reportTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.wakeTimer) clearTimeout(this.wakeTimer);
		this.reportTimer = undefined;
		this.retryTimer = undefined;
		this.wakeTimer = undefined;
	}

	/** Cancel a debounce timer once its queue has drained (close must not leave one armed). */
	private clearEmptyTimers(): void {
		if (this.pendingWake.size === 0 && this.wakeTimer) {
			clearTimeout(this.wakeTimer);
			this.wakeTimer = undefined;
		}
		if (this.pendingReports.length === 0 && this.reportTimer) {
			clearTimeout(this.reportTimer);
			this.reportTimer = undefined;
		}
	}
}
