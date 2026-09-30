/**
 * reporting.ts — child→parent collaboration types shared by the child
 * extension and the persistent job runner. Pure types only.
 */

/** Per-segment reporting bookkeeping shared with the job runner. The runner
 *  resets these before each work segment and reads `reported` when the segment
 *  settles to distinguish an explicit "nothing to report" from silence. */
export interface SegmentState {
	reported: boolean;
	nudged: boolean;
}

/** A child→parent report as submitted by the `report_to_parent` tool. */
export interface ReportInput {
	summary: string;
	body?: string;
	urgent?: boolean;
}

/** Reporting wiring injected by the persistent job runner. `send` must target
 *  the PARENT session; the child extension's own `pi.sendMessage` only ever
 *  reaches the child. */
export interface ReportingOptions {
	send: (report: ReportInput) => void;
	segment: SegmentState;
}