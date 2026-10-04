/**
 * watch.ts — shared types for job watches (waiting without sleeping): the
 * `job_watch` tool surface, its registration API, and the record shapes.
 *
 * Pure types only. The live engine is pi-submarine's watches.ts; the tool
 * factory is job-watch-tool.ts. One API serves the parent AND subagent
 * children: identical surface, identical code path — the only differences are
 * invisible (owner scoping, fire routing, and where notices are delivered).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** What a watch waits for. Optional if a heartbeat cadence is set.
 *  `file-contains.pattern` is a JavaScript regex (m-flagged: ^/$ are line
 *  anchors) matched against new log data — `^THE LINE$` matches one exact line.
 *  `file-quiet` fires on silence: use only when the job is expected to chatter. */
export type WatchTrigger =
	| { kind: "pid-exit"; pid: number }
	| { kind: "file-contains"; path: string; pattern: string }
	| { kind: "file-quiet"; path: string; seconds: number }
	| { kind: "deadline"; at: number };

/** Who a fired watch talks to. Child-owned watches resume their job. */
export type WatchOwner = { kind: "parent" } | { kind: "child"; jobId: string };

/** Input to register a watch. */
export interface WatchInput {
	/** Terminal trigger; omit for a heartbeat-only watch (cancelled manually). */
	trigger?: WatchTrigger | undefined;
	/** Terminal triggers — ANY of them firing wakes/resumes (OR semantics).
	 *  Takes precedence over `trigger` when present. */
	triggers?: WatchTrigger[] | undefined;
	/** Death guard: if this pid ends (exit, reboot, pid reuse), the watch fires
	 *  even when its own condition never happens. Death is never silent. */
	guardPid?: number | undefined;
	/** Preview/progress source: the last non-empty line rides every event. */
	logPath?: string | undefined;
	/** Heartbeat cadence in ms; each tick delivers a preview wake. */
	heartbeatMs?: number | undefined;
	/** Human label shown in wakes and listings. */
	label?: string | undefined;
	/** Teardown-survival verdict recorded at attach time (see job-watch-tool). */
	survival?: string | undefined;
	/** Watch lifetime in minutes (default 30). One pre-expiry warning is sent;
	 *  extend to keep a long job watched. */
	lifetimeMinutes?: number | undefined;
}

/** Bounded view of a watch handed to listings. */
export interface WatchView {
	id: string;
	owner: WatchOwner;
	label: string;
	state: "pending" | "fired" | "cancelled" | "expired";
	trigger?: WatchTrigger | undefined;
	heartbeatMs?: number | undefined;
	logPath?: string | undefined;
	createdAt: number;
	expiresAt: number;
	firedAt?: number | undefined;
	verdict?: string | undefined;
	lastLine?: string | undefined;
	survival?: string | undefined;
	/** The full trigger set — ANY of these firing fires the watch. */
	triggers?: WatchTrigger[] | undefined;
	/** Set when this watch is death-guarded by a pid. */
	guardPid?: number | undefined;
	/** Set when a sibling session holds the waiters for this watch. */
	claimedBy?: number | undefined;
}

/** Result of an api call that creates a watch. */
export type JobWatchCreateResult =
	| { ok: true; id: string; pid?: number; logPath?: string; survival?: string; notice?: string }
	| { ok: false; reason: string };

/**
 * The registration API behind the `job_watch` tool. ONE implementation backs
 * both the parent and child tool registrations — parent calls are global,
 * child calls are scoped to their job by the same impl.
 */
export interface JobWatchApi {
	/** Register a watch (condition + optional heartbeat). */
	register(input: WatchInput): JobWatchCreateResult;
	/**
	 * Adopt an already-running (usually already-backgrounded) process: register
	 * a pid-exit watch, adopt its log when capturable, and record a teardown
	 * survival verdict.
	 */
	attach(opts: { pid: number; logPath?: string; label?: string; heartbeatMs?: number; lifetimeMinutes?: number }): JobWatchCreateResult;
	/**
	 * Gate the command, launch it detached from pi (survives pi exiting), tee
	 * to a log, and register a pid-exit watch.
	 */
	run(opts: { command: string; logPath?: string; label?: string; heartbeatMs?: number; lifetimeMinutes?: number }, ctx: ExtensionContext): Promise<JobWatchCreateResult>;
	/** Watches visible to this scope (parent: all; child: its own). */
	list(): WatchView[];
	/** Pull the tail of a watch's log. */
	tail(id: string, n: number): string;
	/** Cancel a pending watch (ownership enforced by scope). */
	cancel(id: string): { ok: boolean; reason: string };
	/** Extend a pending watch's lifetime (minutes from now). */
	extend(id: string, lifetimeMinutes: number): { ok: boolean; reason: string };
	/**
	 * Deliver a notice to whoever decides what to do about it: the parent
	 * model. Parent scope queues a session event; child scope reports up.
	 */
	notifyParent(text: string): void;
}
