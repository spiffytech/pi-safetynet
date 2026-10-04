/**
 * reviewer-state.ts — permission-review circuit-breaker state and review
 * execution. Harness-free: transcript source and subagent spawn are injected.
 */
import type { ReviewVerdict, ReviewerAssessment, SessionEntriesSource, ProfileName } from "./types.ts";
import type { PermissionCheck } from "./check.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  formatActionJson,
  validateAssessment,
  buildSubmitVerdictTool,
  SUBMIT_VERDICT_TOOL_NAME,
  compactTranscript,
  type ActionJsonOpts,
  type TranscriptEntry,
} from "./reviewer-prompt.ts";
import { isReadOnly } from "./profiles.ts";
import { debugLog } from "./debug-log.ts";

/** JSON.stringify that never throws (circular refs, BigInt). */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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
}

// ─── Review execution ──────────────────────────────────────────────────────

export interface ReviewDeps {
  /** Function to spawn a subagent session. Production = runSubagent. */
  spawn: (opts: any) => Promise<SpawnResult>;
  /** On-screen diagnostic sink for review outcomes the user must see. Pipelines
   *  wire this to ctx.ui.notify, which renders through the TUI and so cannot
   *  interleave with frames the way console.warn did. Absent → diagnostics are
   *  dropped (tests, headless callers). */
  onDiagnostic?: (message: string, level: "info" | "warning") => void;
}

/** Render the reviewer fallback chain as one readable line: the models that
 *  failed and why, then the model that produced the verdict (if any). */
export function formatReviewerFallback(
  failures: readonly { spec: string; message: string }[],
  winner?: string,
): string {
  const chain = failures.map((f) => `${f.spec} (${f.message})`).join(", ");
  return winner
    ? `reviewer fell back: ${chain} → ${winner}`
    : `reviewer unavailable — all models failed: ${chain}`;
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
  promptKeybindings?: any;
  autoDenyConfig?: any;
  trustExternalPaths?: boolean;
  cwd: string;
  model?: any;
  thinkingLevel?: string;
  /** Structured-verdict tool the reviewer must call. Forwarded to the subagent
   *  runner, which registers it and returns its arguments as `details.verdict`. */
  verdictTool?: unknown;
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

/** Resolve an `autoApprove.model` spec against the parent session's model
 *  registry. Unresolvable ids fall back silently to the parent model rather
 *  than erroring the caller. Harness compatibility: registries disagree about
 *  whether `id` carries the provider prefix (hyper stores id="qwen3.8-flash" +
 *  provider="hyper"; other catalogs store id="alibaba/qwen3.8-flash") — both
 *  forms match. Generic in M so a catalog Model instance survives the trip to
 *  runSubagent's `model` param. */
export function resolveModelSpec<M extends { id: string; provider?: string }>(
  ctx: { modelRegistry?: { getAll(): M[] } },
  modelSpec: string | undefined,
  /** Who is falling back — only used in the warning text. */
  label = "reviewer",
): M | undefined {
  if (!modelSpec || !ctx.modelRegistry) return undefined;
  const found = ctx.modelRegistry
    .getAll()
    .find((m) => m.id === modelSpec || `${m.provider}/${m.id}` === modelSpec);
  if (!found) {
    debugLog(`safetynet: autoApprove.model "${modelSpec}" not found in registry; ${label} will use the parent model.`);
  }
  return found;
}

/** Whether a provider error is a credential rejection — a per-model condition
 *  the fallback chain can route around, unlike a transport blip. */
function isAuthFailure(message: string): boolean {
  return /\b401\b|unauthori[sz]ed|authentication failed|not authenticated|invalid.?api.?key|incorrect.?api.?key/i.test(message);
}

/** Whether a provider error is a billing/credit refusal (HTTP 402). Unlike an
 *  auth rejection this is an *account-level* condition: every model on that
 *  provider will fail the same way, so the chain should advance to the next
 *  provider — and skip the rest of this one. */
function isBillingFailure(message: string): boolean {
  return /\b402\b|billing[_ ]error|out of credits|insufficient (?:credits|funds|balance|quota)|quota exceeded|payment required/i.test(message);
}

/** The provider a spec belongs to, for same-provider billing skips. Prefers the
 *  registry-resolved provider (covers bare ids), else a `provider/model`
 *  prefix. Undefined when neither can determine it — then no skip is applied. */
function specProvider(
  ctx: ReviewCallOpts["parentCtx"],
  spec: string,
): string | undefined {
  const resolved = resolveModelSpec(ctx, spec);
  if (resolved?.provider) return resolved.provider;
  const slash = spec.indexOf("/");
  return slash > 0 ? spec.slice(0, slash) : undefined;
}

/** Run a permission review and classify the result.
 *
 *  When `opts.model` is a list, each spec is tried in order — but only for
 *  failures that mean the model cannot produce a verdict (unknown provider,
 *  missing model, rejected credential, billing refusal, unusable output). A
 *  retryable transport failure (connection error, timeout, abort) stops the
 *  chain: pi already retried that model inside the subagent, and the next model
 *  would ride the same network, so spending a fallback on it would just hide
 *  the blip.
 *
 *  Billing failures (402) are account-level: once one model on a provider is
 *  out of credits, the remaining specs on that provider are skipped rather than
 *  spent re-hitting the same wall. Specs on other providers still run. */
export async function runPermissionReview(
  opts: ReviewCallOpts,
  deps: ReviewDeps,
): Promise<ReviewVerdict> {
  const specs = Array.isArray(opts.model) ? opts.model : opts.model ? [opts.model] : [];
  // No model configured → single attempt on the parent model (historical default).
  if (specs.length === 0) return runPermissionReviewWithModel(opts, deps, "");
  const failures: { spec: string; message: string }[] = [];
  // Providers already known to be out of credits this review — later specs on
  // them are skipped so the chain doesn't waste a hop on the same 402.
  const billingDeadProviders = new Set<string>();
  for (let i = 0; i < specs.length; i++) {
    // The caller aborts this signal at its review deadline. Stop before
    // spawning another model: a cancelled review must not start new work, and
    // the pipeline has already fallen through to the manual prompt.
    if (opts.signal?.aborted) {
      return { kind: "transient", message: "Reviewer was aborted" };
    }
    const spec = specs[i]!;
    const provider = specProvider(opts.parentCtx, spec);
    if (provider && billingDeadProviders.has(provider)) {
      failures.push({
        spec,
        message: `skipped — provider "${provider}" is out of credits`,
      });
      debugLog(`safetynet: reviewer model "${spec}" skipped — provider "${provider}" already returned a billing error.`);
      continue;
    }
    const verdict = await runPermissionReviewWithModel(opts, deps, spec);
    if (verdict.kind === "assessment") {
      // A fallback happened → surface the whole chain once, so a silent hop to
      // a working model is still visible to the user.
      if (failures.length > 0) {
        deps.onDiagnostic?.(formatReviewerFallback(failures, spec), "warning");
      }
      return verdict;
    }
    // A retryable transport failure is not a model-availability problem. pi
    // already retried inside the subagent; stop here and let the user decide
    // rather than spending a fallback on a blip.
    if (verdict.kind === "transient") {
      return verdict;
    }
    // fatal → this model cannot produce a verdict. Try the next configured one.
    failures.push({ spec, message: verdict.message });
    // Billing refusals condemn the whole provider, not just this model.
    if (provider && isBillingFailure(verdict.message)) {
      billingDeadProviders.add(provider);
    }
    if (i < specs.length - 1) {
      debugLog(`safetynet: reviewer model "${spec}" unavailable (${verdict.message}); falling back to next model.`);
    }
  }
  if (failures.length > 0) {
    deps.onDiagnostic?.(formatReviewerFallback(failures), "warning");
    // Every configured model was unavailable. Report fatal so the pipeline can
    // disable auto-approve — a chain with no usable model cannot gate actions.
    return { kind: "fatal", message: formatReviewerFallback(failures) };
  }
  // Unreachable in practice (specs.length > 0 implies a failure was recorded),
  // kept as a conservative fall-through.
  return { kind: "transient", message: "No reviewer model configured" };
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

  // Build task prompt. State the project root explicitly (as well as inside the
  // action JSON) so the reviewer cannot mistake a directory mentioned in the
  // transcript for the project the action runs in.
  let taskPrompt = `## Project root\n${opts.cwd}\n\n## Transcript\n${transcriptStr}\n\n## Planned action\n${actionJson}\n\nCall ${SUBMIT_VERDICT_TOOL_NAME} exactly once with your verdict.`;
  if (opts.retryReason) {
    taskPrompt = `## Retry reason\n${opts.retryReason}\n\n${taskPrompt}`;
  }

  // Resolve the configured reviewer model against the parent catalog (falls
  // back to the parent model when unset or unresolvable).
  const modelOverride = resolveModelSpec(opts.parentCtx, modelSpec);

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
    verdictTool: buildSubmitVerdictTool(),
    ...(modelOverride ? { model: modelOverride } : {}),
  });
  debugLog(
    `safetynet: review timing — model="${modelSpec}" transcript=${transcriptMs}ms resolve=${spawnT0 - reviewT0 - transcriptMs}ms spawn=${Date.now() - spawnT0}ms total=${Date.now() - reviewT0}ms`,
  );

  // Classify the result
  const text = result.content.map((c) => c.text).join("\n").trim();
  if (result.details.error) {
    const errMsg = String(result.details.error);
    // A session that boots without a model is a transient state (model/auth
    // config can change). It must NOT hit the "create" match below, which is
    // an accident of the /login hint text in omp's error message.
    if (errMsg.includes("No model selected")) {
      return { kind: "transient", message: errMsg };
    }
    // The model cannot produce a verdict at all: unknown provider, model
    // missing from the catalog, session-creation failure, or a rejected
    // credential. The fallback chain exists for exactly this — advance to the
    // next configured model.
    if (
      errMsg.includes("create") ||
      errMsg.includes("not found") ||
      errMsg.includes("Unknown provider") ||
      isAuthFailure(errMsg) ||
      isBillingFailure(errMsg)
    ) {
      return { kind: "fatal", message: errMsg };
    }
    // Everything else is a retryable infrastructure failure (connection error,
    // timeout, 5xx, …). pi already retried this model inside the subagent; a
    // fallback would ride the same network, so classify it transient — the
    // chain stops and the user decides.
    return { kind: "transient", message: errMsg };
  }
  if (result.details.hitTimeout) {
    return { kind: "transient", message: "Reviewer timed out" };
  }
  if (result.details.aborted) {
    return { kind: "transient", message: "Reviewer was aborted" };
  }
  // The reviewer reports its verdict by calling submit_verdict; read the tool
  // arguments. No prose parsing. `details.verdict` is set by the subagent
  // runners (pi `runSubagent`, omp `spawnReviewer`) when the tool was called.
  const rawVerdict = result.details.verdict;
  if (rawVerdict !== undefined) {
    const assessment = validateAssessment(rawVerdict);
    if (!assessment) {
      debugLog(
        `safetynet: reviewer "${modelSpec}" ${SUBMIT_VERDICT_TOOL_NAME} arguments failed validation: ${safeStringify(rawVerdict).slice(0, 300)}`,
      );
      return { kind: "fatal", message: "Reviewer submitted an invalid verdict" };
    }
    return { kind: "assessment", assessment };
  }

  // No verdict tool call. Report the known no-output cases accurately instead
  // of blaming JSON parsing; anything else is the model declining to use it.
  if (result.details.hitPermissionDenied) {
    return { kind: "fatal", message: "Reviewer stopped: permission denied" };
  }
  if (result.details.noOutput) {
    return { kind: "fatal", message: "Reviewer returned no output" };
  }
  if (result.details.hitTurnLimit) {
    return { kind: "fatal", message: "Reviewer hit the turn limit before submitting a verdict" };
  }
  debugLog(
    `safetynet: reviewer "${modelSpec}" did not call ${SUBMIT_VERDICT_TOOL_NAME}; raw text (${text.length} chars): ${text.slice(0, 500)}`,
  );
  return { kind: "fatal", message: `Reviewer did not call ${SUBMIT_VERDICT_TOOL_NAME}` };
}
