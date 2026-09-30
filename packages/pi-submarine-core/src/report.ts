/**
 * report.ts — size caps shared by the child→parent report tool and the job
 * registry. Every model-facing payload gets a hard cap with an explicit
 * truncation marker; no giant pushes across the parent/child boundary.
 */

/** Maximum number of characters kept from a report body. */
export const REPORT_BODY_MAX = 4000;
/** Maximum number of characters kept from a report summary. */
export const REPORT_SUMMARY_MAX = 300;
/** Maximum number of characters kept from a parent→child message. */
export const REPORT_MESSAGE_MAX = 4000;
/** Maximum number of characters kept from a stored bash output tail. */
export const BASH_TAIL_MAX = 8000;
/** Appended to any payload that was cut at its cap. */
export const REPORT_TRUNCATION_MARKER = "\n… [truncated]";

/** Truncate text to `max` characters, appending the marker when it was cut. */
export function capText(text: string | undefined, max: number): string {
	if (!text) return "";
	if (text.length <= max) return text;
	return text.slice(0, max) + REPORT_TRUNCATION_MARKER;
}

/** Truncate a report body to the cap, appending the marker when it was cut. */
export function capReportBody(body: string | undefined): string {
	return capText(body, REPORT_BODY_MAX);
}

/** Truncate a report summary to the cap. */
export function capReportSummary(summary: string | undefined): string {
	return capText(summary, REPORT_SUMMARY_MAX);
}

/** Truncate a parent→child message to the cap. */
export function capReportMessage(message: string | undefined): string {
	return capText(message, REPORT_MESSAGE_MAX);
}

/** Truncate a stored bash tail to the byte-ish cap. */
export function capBashTail(tail: string | undefined): string {
	return capText(tail, BASH_TAIL_MAX);
}
