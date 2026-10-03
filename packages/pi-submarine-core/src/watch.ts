/**
 * watch.ts — shared types for watch registrations (job/file/pid watches that
 * wake a parent or resume a child without any agent sleeping).
 *
 * Pure types only: the live engine lives in pi-submarine (watches.ts), the
 * child tool surface in child-ext.ts. Waiting is infrastructure, not reasoning —
 * nothing here runs inside an LLM turn.
 */

/** What a watch waits for. Optional if a heartbeat cadence is set. */
export type WatchTrigger =
	| { kind: "pid-exit"; pid: number }
	| { kind: "file-contains"; path: string; pattern: string }
	| { kind: "deadline"; at: number };

/** Who a fired watch talks to. Child-owned watches resume their job. */
export type WatchOwner = { kind: "parent" } | { kind: "child"; jobId: string };

/** Input to register a watch (parent tool and child tool share this shape). */
export interface WatchInput {
	/** Terminal trigger; omit for a heartbeat-only watch (cancelled manually). */
	trigger?: WatchTrigger | undefined;
	/** Preview/progress source: the last non-empty line rides every event. */
	logPath?: string | undefined;
	/** Heartbeat cadence in ms; each tick delivers a preview wake. */
	heartbeatMs?: number | undefined;
	/** Human label shown in wakes and listings. */
	label?: string | undefined;
}

/** Bounded view of a watch handed to the parent/child in listings. */
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
}

/** The registration surface exposed to a child as the `watch_for` tool. */
export interface WatchOptions {
	register(input: WatchInput): { ok: true; id: string } | { ok: false; reason: string };
	cancel(id: string): { ok: boolean; reason: string };
	list(): WatchView[];
}