/**
 * reviewer-state.ts — permission-review circuit-breaker state and review
 * execution. Harness-free: transcript source and subagent spawn are injected.
 */
import type { ReviewVerdict, ReviewerAssessment, SessionEntriesSource, ProfileName } from "./types.ts";
import type { PermissionCheck } from "./check.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  formatActionJson,
  parseAssessment,
  compactTranscript,
  type ActionJsonOpts,
  type TranscriptEntry,
} from "./reviewer-prompt.ts";
import { isReadOnly } from "./profiles.ts";

// ─── Module state (circuit breaker + turn token) ───────────────────────────

/** Reset on agent_end, incremented on deny, reset on allow. */
let consecutiveDenies = 0;

/** Bumped on agent_end; verdicts with a stale token are discarded. */
let turnToken = 0;

/** Re-entrancy guard. */
let reviewActive = false;

export function reviewConsecutiveDenies(): number { return consecutiveDenies; }
export function reviewResetDenies(): void { consecutiveDenies = 0; }
export function reviewIncrementDenies(): number { return ++consecutiveDenies; }
export function reviewTurnToken(): number { return turnToken; }
export function reviewBumpTurnToken(): void { turnToken++; }
export function reviewIsActive(): boolean { return reviewActive; }
export function reviewSetActive(v: boolean): void { reviewActive = v; }

// ─── Reviewer latency EMA (sticky slow-reviewer warning) ───────────────────

/** Exponential moving average of completed review wall-times, in ms.
 *  Alpha 0.3: responsive enough to flag a slow model within ~3 reviews,
 *  stable enough not to flap on one outlier. */
let latencyEmaMs: number | null = null;

/** Record a completed review's wall time and return the current EMA. */
export function reviewRecordLatency(ms: number): number {
  latencyEmaMs = latencyEmaMs === null ? ms : Math.round(latencyEmaMs * 0.7 + ms * 0.3);
  return latencyEmaMs;
}

export function reviewLatencyEma(): number | null { return latencyEmaMs; }

/** Reset all state for tests. */
export function resetReviewStateForTests(): void {
  consecutiveDenies = 0;
  turnToken = 0;
  reviewActive = false;
  latencyEmaMs = null;
  pendingAutoResult = null;
}

// ─── Pending auto result (for background retry store-then-abort) ──────
let pendingAutoResult: any = null;
export function setPendingAutoResult(value: any): void { pendingAutoResult = value; }
export function getPendingAutoResult(): any { return pendingAutoResult; }
export function clearPendingAutoResult(): void { pendingAutoResult = null; }

// ─── Review execution ──────────────────────────────────────────────────────

export interface ReviewDeps {
  /** Function to spawn a subagent session. Production = runSubagent. */
  spawn: (opts: any) => Promise<SpawnResult>;
}

export interface SpawnOpts {
  taskType: "explore" | "build";
  prompt: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  parentCtx: SessionEntriesSource & {
    cwd?: string;
    modelRegistry?: { getAll(): Array<{ id: string; provider?: string }> };
  };
  parentStorage?: any;
  initialRules?: any[];
  promptKeybindings?: any;
  autoDenyConfig?: any;
  trustExternalPaths?: boolean;
  cwd: string;
  model?: any;
  thinkingLevel?: string;
}

export interface SpawnResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

export interface ReviewCallOpts {
  permission: "bash" | "read" | "edit";
  target: string;
  check: PermissionCheck;
  cwd: string;
  /** Parent session's context — used for transcript. */
  parentCtx: SessionEntriesSource & {
    cwd?: string;
    modelRegistry?: { getAll(): Array<{ id: string; provider?: string }> };
  };
  /** Profile string for action JSON (canonicalized to ro/rw below). */
  profile: ProfileName;
  signal?: AbortSignal;
  timeoutMs: number;
  /** Retry reason injected at the top of the task prompt (background-retry path). */
  retryReason?: string;
  /** Reviewer model spec (or fallback list, tried in order). */
  model?: string | string[];
}

/** Run a permission review and classify the result. When `opts.model` is a
 *  list, each spec is tried in order until one produces a usable verdict;
 *  the last failure is returned otherwise. */
export async function runPermissionReview(
  opts: ReviewCallOpts,
  deps: ReviewDeps,
): Promise<ReviewVerdict> {
  const specs = Array.isArray(opts.model) ? opts.model : opts.model ? [opts.model] : [];
  // No model configured → single attempt on the parent model (historical default).
  if (specs.length === 0) return runPermissionReviewWithModel(opts, deps, "");
  let lastVerdict: ReviewVerdict | undefined;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const verdict = await runPermissionReviewWithModel(opts, deps, spec);
    if (verdict.kind === "assessment") return verdict;
    lastVerdict = verdict;
    if (i < specs.length - 1) {
      console.warn(`safetynet: reviewer model "${spec}" failed (${verdict.message}); falling back to next model.`);
    }
  }
  return lastVerdict ?? { kind: "transient", message: "No reviewer model configured" };
}

/** Run a single review attempt against one resolved model spec. */
async function runPermissionReviewWithModel(
  opts: ReviewCallOpts,
  deps: ReviewDeps,
  modelSpec: string,
): Promise<ReviewVerdict> {
  // Build transcript from parent session entries
  const reviewT0 = Date.now();
  let transcriptStr = "(no transcript available)";
  let transcriptMs = 0;
  try {
    const entries = opts.parentCtx.sessionManager.getEntries();
    const transcriptEntries: TranscriptEntry[] = [];
    for (const e of entries) {
      if (e.type === "message") {
        const msg = (e as { message: { role: string; content: string | Array<{ type: string; text?: string }> } }).message;
        // Trajectory: only the user's own messages establish intent/authorization.
        // Assistant tool calls/outputs are momentum-bias and are intentionally
        // NOT included — the reviewer independently verifies local state with its
        // read-only tools (read/grep/find/ls) when it needs to.
        if (msg.role === "user") {
          const text = typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((c: { type: string; text?: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join(" ")
              : "";
          if (text.trim()) {
            transcriptEntries.push({ role: msg.role, text, timestamp: (e as { timestamp?: string }).timestamp ?? "" });
          }
        }
      }
    }
    transcriptStr = compactTranscript(transcriptEntries);
    transcriptMs = Date.now() - reviewT0;
  } catch {
    // If we can't build the transcript, proceed without one
  }

  // Build action JSON. Canonicalize the mode to the ro/rw pair the reviewer
  // prompt defines: plan→ro, build→rw, ro/rw pass through unchanged. The
  // reviewer must not have to know which paradigm the session uses.
  const actionOpts: ActionJsonOpts = {
    permission: opts.permission,
    target: opts.target,
    cwd: opts.cwd,
    ...(opts.check.unapproved ? { subcommands: opts.check.unapproved } : {}),
    ...(opts.check.redirectTargets ? { redirectTargets: opts.check.redirectTargets } : {}),
    profile: isReadOnly(opts.profile) ? "ro" : "rw",
  };
  const actionJson = formatActionJson(actionOpts);

  // Build task prompt
  let taskPrompt = `## Transcript\n${transcriptStr}\n\n## Planned action\n${actionJson}\n\nReturn strict JSON only.`;
  if (opts.retryReason) {
    taskPrompt = `## Retry reason\n${opts.retryReason}\n\n${taskPrompt}`;
  }

  // Resolve the model spec against the parent session's model registry.
  // Unresolvable ids fall back silently to the parent model rather than
  // erroring the review.
  // Harness compatibility: registries disagree about whether `id` carries
  // the provider prefix (hyper stores id="qwen3.8-flash" + provider="hyper";
  // other catalogs store id="alibaba/qwen3.8-flash"). Match both forms.
  let modelOverride: { id: string; provider?: string } | undefined;
  if (modelSpec && opts.parentCtx.modelRegistry) {
    modelOverride = opts.parentCtx.modelRegistry.getAll().find(
      (m) => m.id === modelSpec || `${m.provider}/${m.id}` === modelSpec,
    );
    if (!modelOverride) {
      console.warn(`safetynet: autoApprove.model "${modelSpec}" not found in registry; reviewer will use the parent model.`);
    }
  }

  // Run the reviewer subagent
  const spawnT0 = Date.now();
  const result = await deps.spawn({
    taskType: "explore",
    prompt: taskPrompt,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs,
    parentCtx: opts.parentCtx,
    cwd: opts.cwd,
    trustExternalPaths: true,
    ...(modelOverride ? { model: modelOverride } : {}),
  });
  if (typeof console !== "undefined") {
    console.warn(
      `safetynet: review timing — model="${modelSpec}" transcript=${transcriptMs}ms resolve=${spawnT0 - reviewT0 - transcriptMs}ms spawn=${Date.now() - spawnT0}ms total=${Date.now() - reviewT0}ms`,
    );
  }

  // Classify the result
  const text = result.content.map((c) => c.text).join("\n").trim();
  if (result.details.error) {
    const errMsg = String(result.details.error);
    // Fatal only when recovery in-session is impossible (structural/session
    // creation failures). Auth/credential failures are transient: an expired or
    // rejected token can refresh on a later retry, so they must flow to the
    // background-retry path instead of permanently disabling auto-approve.
    if (errMsg.includes("create") || errMsg.includes("not found") || errMsg.includes("Unknown provider")) {
      return { kind: "fatal", message: errMsg };
    }
    return { kind: "transient", message: errMsg };
  }
  if (result.details.hitTimeout) {
    return { kind: "transient", message: "Reviewer timed out" };
  }
  if (result.details.aborted) {
    return { kind: "transient", message: "Reviewer was aborted" };
  }
  if (!text) {
    return { kind: "transient", message: "Reviewer returned empty output" };
  }

  const assessment = parseAssessment(text);
  if (!assessment) {
    return { kind: "transient", message: "Could not parse reviewer JSON output" };
  }

  return { kind: "assessment", assessment };
}