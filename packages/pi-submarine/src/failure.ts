/**
 * failure.ts — out-of-band subagent failure marking.
 *
 * `AgentToolResult` has no `isError` field and throwing discards the partial
 * result, so a failed subagent's verdict is recorded by the tool's `execute`
 * and applied by the entry's `tool_result` handler. Keyed by toolCallId — the
 * only identifier both share — so concurrent subagents cannot collide.
 * Consuming (rather than peeking) keeps the set from growing and stops a
 * verdict applying twice.
 */

const subagentFailures = new Set<string>();

/** Record a subagent call whose result should be reported as an error. */
export function recordSubagentFailure(toolCallId: string): void {
	subagentFailures.add(toolCallId);
}

/**
 * Consume a recorded failure for this tool call, returning the `isError` patch.
 * Returns undefined for calls never recorded as failures, so unrelated tools
 * (and successful subagents) are untouched.
 */
export function consumeSubagentFailure(toolCallId: string): { isError: true } | undefined {
	if (!subagentFailures.delete(toolCallId)) return undefined;
	return { isError: true };
}

/** Drop any unconsumed failures (their tool_result never fired). */
export function clearSubagentFailures(): void {
	subagentFailures.clear();
}