/**
 * usage.ts — pure pi-ai `Usage` accumulators and subagent result semantics.
 * No state, no pi imports beyond types: this module is safe to carry in every
 * package's own module graph.
 */

import type { Usage } from "@earendil-works/pi-ai";

/** Subagent session flavor. */
export type SubagentTaskType = "explore" | "build";

/** Zeroed pi-ai `Usage` accumulator. */
export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Whether an accumulator has seen no billable activity yet. */
export function isZeroUsage(usage: Usage): boolean {
	return (
		(usage.input || 0) === 0 &&
		(usage.output || 0) === 0 &&
		(usage.cacheRead || 0) === 0 &&
		(usage.cacheWrite || 0) === 0 &&
		(usage.cost?.total || 0) === 0
	);
}

/**
 * Fold one assistant message's usage into an accumulator.
 *
 * `totalTokens` mirrors pi's own fallback (`usage.totalTokens || sum of parts`), so a
 * provider that reports no total still contributes a sensible figure. This value is
 * never used for context accounting — pi reads usage only from assistant messages in
 * the main session — it just has to be present on the `Usage` we hand back.
 */
export function accumulateUsage(target: Usage, usage: Usage): void {
	target.input += usage.input || 0;
	target.output += usage.output || 0;
	target.cacheRead += usage.cacheRead || 0;
	target.cacheWrite += usage.cacheWrite || 0;
	target.totalTokens += usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
	target.cost.input += usage.cost?.input || 0;
	target.cost.output += usage.cost?.output || 0;
	target.cost.cacheRead += usage.cost?.cacheRead || 0;
	target.cost.cacheWrite += usage.cost?.cacheWrite || 0;
	target.cost.total += usage.cost?.total || 0;
}

/** Deep copy of an accumulator, safe to hand to pi as a tool-result `usage`. */
export function snapshotUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

/** Usage delta of `total` minus `part` (both may be partial). */
export function subtractUsage(total: Usage, part: Usage): Usage {
	return {
		input: (total.input || 0) - (part.input || 0),
		output: (total.output || 0) - (part.output || 0),
		cacheRead: (total.cacheRead || 0) - (part.cacheRead || 0),
		cacheWrite: (total.cacheWrite || 0) - (part.cacheWrite || 0),
		totalTokens: (total.totalTokens || 0) - (part.totalTokens || 0),
		cost: {
			input: (total.cost?.input || 0) - (part.cost?.input || 0),
			output: (total.cost?.output || 0) - (part.cost?.output || 0),
			cacheRead: (total.cost?.cacheRead || 0) - (part.cost?.cacheRead || 0),
			cacheWrite: (total.cost?.cacheWrite || 0) - (part.cost?.cacheWrite || 0),
			total: (total.cost?.total || 0) - (part.cost?.total || 0),
		},
	};
}

/**
 * Whether a subagent's result should be reported to the model as a tool error.
 *
 * `AgentToolResult` has no `isError` field — pi derives it solely from whether
 * `execute()` throws — so a non-throwing tool always looks successful. We can't
 * throw instead: the agent loop discards the whole result on throw, taking the
 * partial findings and the `usage` we attach with it. So failures are flagged
 * out-of-band and applied by a `tool_result` handler.
 *
 * Matches pi's own convention, where a blocked tool call and a timed-out bash
 * command are both errors. Anything short of the subagent doing its job counts:
 * the parent should see a red result and re-plan, not a green one that happens to
 * contain the word "Error". Partial output and details survive either way.
 */
export function isSubagentFailure(details: Record<string, unknown> | undefined): boolean {
	if (!details) return false;
	return Boolean(
		details.error ||
		details.aborted ||
		details.hitPermissionDenied ||
		details.hitTurnLimit ||
		details.hitTimeout,
	);
}