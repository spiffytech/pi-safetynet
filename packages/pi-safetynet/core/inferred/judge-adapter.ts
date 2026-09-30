/**
 * judge-adapter.ts — production adapter for the inferred-rule judge.
 *
 * The judge is one background model call per ripened shape. It runs through the
 * parent `ModelRegistry` (provider-neutral, request-time auth) rather than a
 * spawned subagent session, so it sends only the judge system prompt plus the
 * single judge prompt — never the session transcript — and costs one request
 * instead of constructing a ModelRuntime, resource loader, and agent session.
 *
 * Usage is written back as a `type: "usage"` session entry so Pi's own totals,
 * /session, and the safetynet footer count it like cache-warming spend.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JUDGE_SYSTEM_PROMPT } from "./judge.ts";
import { resolveModelSpec } from "../reviewer-state.ts";
import { loadAutoApproveConfig } from "../auto-config-state.ts";

/** The judge is background and fail-safe; cap it like the reviewer subagent. */
const JUDGE_TIMEOUT_MS = 30_000;

/**
 * Surface of the real `SessionManager` used to record background inference.
 * `ExtensionContext.sessionManager` is typed `ReadonlySessionManager`, whose
 * `Pick` omits `appendUsage`; the runtime object is the full manager — the same
 * one cache warming writes through. Guarded so an API change degrades to a
 * no-op instead of breaking the judge.
 */
interface UsageSink {
	appendUsage?(
		kind: string,
		provider: string,
		model: string,
		usage: AssistantMessage["usage"],
		note?: string,
	): unknown;
}

/** Record a completed background model call in Pi's native usage accounting. */
export function recordBackgroundUsage(ctx: ExtensionContext, kind: string, message: AssistantMessage): void {
	const sink = ctx.sessionManager as unknown as UsageSink;
	if (typeof sink.appendUsage !== "function") return;
	sink.appendUsage(kind, message.provider, message.responseModel ?? message.model, message.usage, "inferred judge");
}

/** Judge model: configured `autoApprove.model` (first entry), else the parent model. */
function resolveJudgeModel(ctx: ExtensionContext) {
	const spec = loadAutoApproveConfig().model;
	const first = Array.isArray(spec) ? spec[0] : spec;
	return (first ? resolveModelSpec(ctx, first, "judge") : undefined) ?? ctx.model;
}

/**
 * Build the judge's `ask` adapter. `runInferredJudge` passes the already-built
 * user prompt; this sends it as the sole message with `JUDGE_SYSTEM_PROMPT` and
 * returns the model's text. Rejections (provider error, abort, timeout) surface
 * as `transient` verdicts in the caller.
 */
export function createJudgeAsk(ctx: ExtensionContext): (prompt: string) => Promise<string> {
	return async (prompt: string): Promise<string> => {
		const model = resolveJudgeModel(ctx);
		if (!model) throw new Error("No model available for inferred judge");

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
		let message: AssistantMessage;
		try {
			message = await ctx.modelRegistry
				.streamSimple(
					model,
					{
						systemPrompt: JUDGE_SYSTEM_PROMPT,
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					{ signal: controller.signal },
				)
				.result();
		} finally {
			clearTimeout(timeoutId);
		}

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `Judge model ${message.stopReason}`);
		}

		recordBackgroundUsage(ctx, "inferred_judge", message);

		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	};
}
