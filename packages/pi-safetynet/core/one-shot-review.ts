/**
 * one-shot-review.ts — single-completion permission reviewer.
 *
 * The active review methodology: ONE model request answers the review. No
 * agent session, no boot/discovery, no tool loop, no verdict nag retries — the
 * things that turned a 2-second judgment into a 90-second stall and daily
 * provider-quota burn. The prompt, policy text, and structured verdict are
 * identical to the session reviewer; only the execution changes.
 *
 * The session reviewer stays available behind `autoApprove.reviewMode:
 * "session"` (see `pickReviewSpawn`), where its read/grep/glob investigation
 * can still earn its keep on the hard tail.
 *
 * No imports from the pi SDK: the model registry is a structural seam
 * (`OneShotRegistry`) so this file runs and tests under plain Node.
 */
import type { SpawnOpts, SpawnResult, ReviewSpawnFn } from "./reviewer-state.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  ONE_SHOT_ADDENDUM,
  SUBMIT_VERDICT_TOOL_NAME,
  buildSubmitVerdictTool,
} from "./reviewer-prompt.ts";
import { reviewMode } from "./auto-config-state.ts";
import { debugLog } from "./debug-log.ts";

// ─── Structural seams (no SDK imports) ─────────────────────────────────────

/** The slice of pi's ModelRegistry this reviewer needs. `completeSimple` is
 *  one provider round-trip with request-time auth resolution; older facades
 *  expose only `complete`, which is accepted too. */
export interface OneShotRegistry {
  getAll(): Array<{ id: string; provider?: string }>;
  find?(provider: string, modelId: string): unknown;
  completeSimple?(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
  complete?(model: unknown, context: unknown, options?: unknown): Promise<unknown>;
}

/** Minimal shapes of pi-ai's request/response types, matched structurally. */
interface OneShotMessage {
  content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

// ─── Model resolution ──────────────────────────────────────────────────────

/** Resolve the model for the single request: a full catalog Model as passed by
 *  core's chain resolution, a repaired partial ({id, provider}) looked up in
 *  the registry, else the parent session's own model (it is running, so it is
 *  guaranteed present). */
function resolveModel(
  opts: SpawnOpts,
  registry: OneShotRegistry | undefined,
): unknown {
  const m = opts.model as { id?: string; provider?: string; api?: string } | undefined;
  if (m && typeof m.api === "string") return m;
  if (m?.id && registry?.find) {
    const found = m.provider
      ? registry.find(m.provider, m.id)
      : registry.getAll().find((x) => x.id === m.id);
    if (found) return found;
  }
  return (opts.parentCtx as { model?: unknown }).model;
}

// ─── Verdict extraction ────────────────────────────────────────────────────

/** Pull a JSON object out of prose (fenced block or bare `{...}`). Returns
 *  undefined when the text is not a verdict — the caller then reports the
 *  accurate "did not call submit_verdict" failure instead of a parse error. */
export function extractJsonVerdict(text: string): Record<string, unknown> | undefined {
  const unfenced = text.replace(/```[a-zA-Z]*\n?/g, "```").split("```");
  const candidates: string[] = [];
  for (let i = 0; i < unfenced.length; i++) {
    // Content inside fences (odd indexes after split on ```) and raw text both
    // count; the model may emit the JSON anywhere.
    candidates.push(unfenced[i]!);
  }
  const body = candidates.join("\n");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ─── The one-shot reviewer ─────────────────────────────────────────────────

/** One model completion decides the permission review. Drop-in replacement for
 *  the session spawns (`runSubagent` / `spawnReviewer`): same SpawnOpts in,
 *  same SpawnResult out, so core's classification and fallback chain are
 *  unchanged. */
export async function spawnOneShotReviewer(opts: SpawnOpts): Promise<SpawnResult> {
  const t0 = Date.now();
  const registry = opts.parentCtx.modelRegistry as unknown as OneShotRegistry | undefined;
  const model = resolveModel(opts, registry);
  const complete = typeof registry?.completeSimple === "function"
    ? registry.completeSimple.bind(registry)
    : typeof registry?.complete === "function"
      ? registry.complete.bind(registry)
      : undefined;
  if (!complete || !model) {
    const why = !registry
      ? "parent context has no model registry"
      : !complete
        ? `model registry exposes no completion entry point (methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(registry)).join(",")})`
        : "no model — chain spec unresolvable and the parent session has no model";
    debugLog(`safetynet: one-shot reviewer unavailable: ${why}`);
    return {
      content: [{ type: "text" as const, text: "" }],
      details: { error: `one-shot reviewer: ${why}`, turnCount: 1, activities: [] },
    };
  }

  const { name, description, parameters, constrainedSampling } = buildSubmitVerdictTool();
  const context = {
    systemPrompt: `${opts.systemPrompt ?? REVIEWER_SYSTEM_PROMPT}\n\n${ONE_SHOT_ADDENDUM}`,
    messages: [{ role: "user" as const, content: opts.prompt, timestamp: Date.now() }],
    tools: [{ name, description, parameters, constrainedSampling }],
  };
  const reasoning = opts.thinkingLevel && THINKING_LEVELS.has(opts.thinkingLevel)
    ? opts.thinkingLevel
    : "minimal";
  const options = {
    signal: opts.signal,
    // One bounded request: cap output (the verdict is four short fields) and
    // sample deterministically so repeated reviews of the same action agree.
    maxTokens: 2048,
    temperature: 0,
    reasoning,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };

  let msg: OneShotMessage;
  try {
    const request = Promise.resolve(complete(model, context, options));
    msg = (opts.timeoutMs
      ? await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new DOMException("one-shot review deadline", "TimeoutError")),
              opts.timeoutMs,
            );
            // No leak: the request settles or the race is already over.
            request.then(() => clearTimeout(timer), () => clearTimeout(timer));
          }),
        ])
      : await request) as OneShotMessage;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const aborted = opts.signal?.aborted === true;
    const timedOut = e?.name === "TimeoutError" || /deadline|timed? ?out/i.test(String(e?.message ?? ""));
    return {
      content: [{ type: "text" as const, text: "" }],
      details: {
        turnCount: 1,
        activities: [],
        ...(aborted ? { aborted: true } : {}),
        ...(!aborted && timedOut ? { hitTimeout: true } : {}),
        ...(!aborted && !timedOut ? { error: String(e?.message ?? err) } : {}),
      },
    };
  }

  const content = Array.isArray(msg?.content) ? msg.content : [];
  const toolCall = content.find((c) => c?.type === "toolCall" && c.name === SUBMIT_VERDICT_TOOL_NAME);
  const text = content
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

  // Verdict = the tool call's arguments; a JSON verdict in prose is accepted as
  // defense-in-depth for providers that ignore the tool contract.
  let verdict: unknown = toolCall?.arguments;
  if (verdict === undefined && text) verdict = extractJsonVerdict(text);

  const details: Record<string, unknown> = {
    turnCount: 1,
    activities: toolCall ? [SUBMIT_VERDICT_TOOL_NAME] : [],
    ...(verdict !== undefined ? { verdict } : {}),
    ...(msg?.usage ? { usage: msg.usage } : {}),
  };
  if (msg?.stopReason === "error") details.error = msg.errorMessage || "one-shot reviewer: provider error";
  if (msg?.stopReason === "aborted" && opts.signal?.aborted) details.aborted = true;
  details.oneShotMs = Date.now() - t0;
  return { content: [{ type: "text" as const, text }], details };
}

// ─── Methodology selection ─────────────────────────────────────────────────

/** Choose the review methodology for this run.
 *
 *  - `injected` (tests / explicit override) always wins.
 *  - `autoApprove.reviewMode: "session"` (or SAFETYNET_REVIEW_MODE=session)
 *    reactivates the intense session reviewer.
 *  - Otherwise the one-shot reviewer is the active methodology. */
export function pickReviewSpawn(
  injected: ReviewSpawnFn | undefined,
  sessionSpawn: ReviewSpawnFn,
): ReviewSpawnFn {
  if (injected) return injected;
  return reviewMode() === "session" ? sessionSpawn : (spawnOneShotReviewer as ReviewSpawnFn);
}
