/**
 * classifier-review.ts — permission review through a structured decision
 * model (System One style: TypeSafe Jev, Neuralwatt clef-flash).
 *
 * One choice question decides the next move:
 *
 *   allow  — routine local work, non-sensitive reads, including sudo read-only
 *            diagnostics, or an external action the user explicitly requested
 *   narrow — safe but too broad: recursive search outside the project root
 *   ask    — destructive/external/secret/unauthorized; prompt the user
 *   deny   — catastrophic or credential exfiltration; never run
 *
 * The harness maps the choice to behavior. `narrow` is a model-only nudge;
 * `ask` falls through to the normal permission prompt; `deny` is a hard block.
 * The catastrophic floor in the ruleset runs before this classifier.
 *
 * No imports from the pi SDK: the registry is a structural seam
 * (`ClassifierRegistry`) so this file runs and tests under plain Node.
 */
import type { SpawnOpts, SpawnResult } from "./reviewer-state.ts";
import type { ReviewerAssessment } from "./types.ts";
import {
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_CLASSIFIER_THRESHOLD,
  loadAutoApproveConfig,
} from "./auto-config-state.ts";
import { debugLog } from "./debug-log.ts";

// ─── Structural seams (no SDK imports) ─────────────────────────────────────

/** The slice of pi's ModelRegistry this reviewer needs. */
export interface ClassifierRegistry {
  findOfType?(type: string, provider: string, modelId: string): unknown;
  getModelsOfType?(type: string, provider?: string): Array<{ id?: string; provider?: string }>;
  classify?(model: unknown, context: unknown, options?: unknown): Promise<ClassifierResult>;
}

export interface ClassifierAnswer {
  type?: string;
  choice?: string;
  probability?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

interface ClassifierResult {
  answers?: Record<string, ClassifierAnswer>;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  model?: string;
  provider?: string;
}

interface ClassifierModelLike {
  id?: string;
  provider?: string;
  type?: string;
  api?: string;
}

export const CLASSIFIER_CHOICE_IDS = { action: "action" } as const;

export const CLASSIFIER_CHOICE_INSTRUCTIONS = `Decide what this planned action needs before it runs.

The user's own messages are the source of authorization. Session mode is authoritative. If plannedAction.profile is "ro", allow only non-destructive reads; any write, redirect, create/delete, install, or state change is ask. If it is "rw", normal rules apply.

Judge excess, not category. ssh, scp, sudo, deploy, docker, and installs are not reasons to ask by themselves. Ask when the action goes beyond what the user asked for, or somewhere this session does not own.

Boundaries: trustedRoots are the project root, this session's scratch dir, and agent state. Work confined to them is routine local work. Read-only inspection (ls, cat, rg, stat, du, df, free, logs, status endpoints, session/agent files) is routine anywhere non-sensitive — including over ssh to a host the user named or this task already uses, however long the remote script is. What matters is the effect, not the transport.

- allow: work inside trustedRoots or scratchDir; non-destructive reads of non-sensitive data anywhere, including remote and sudo read-only diagnostics (ls, cat, du, df, free, journalctl, systemctl status, dnf log, docker ps/inspect, sqlite3 SELECT, framework_tool); routine local work (edits, commits, installs, scoped deletes, builds); remote, privileged, or egress steps that carry out a task the user authorized, including steps that name a destination the user named (host, service, deploy target), and the checks needed to verify that task.
- narrow: safe work whose scope is the problem — a recursive search outside the project root, a filesystem-wide scan, or a scratch write aimed at another session's scratch dir. Name the smaller target.
- ask: exceeds the requested task or goes somewhere the user did not name: egress to a new destination (push, deploy, ssh, scp, rsync to an unnamed host or service), a production data write beyond the task, a privileged state change the user did not authorize (restarting a service, stopping a daemon, mounting or unmounting, resizing a filesystem), a destructive or hard-to-reverse state change (discarding uncommitted work, git reset --hard, checkout --, clean, history rewrite, broad deletion), a secret read, or external data transfer. Also ask when the transcript gives no authorization at all for this kind of action.
- deny: catastrophic or credential exfiltration. rm -rf /, mkfs, dd of=/dev, shutdown. Never run.

A task-level go-ahead ("go", "do what you need", "turn it on", an approved plan) covers the concrete steps of that task and its named destinations. It does not cover unrelated work, a different destination, or a materially larger effect. Do not require a fresh yes for each step of an authorized task; judge whether this step is part of it.

Typical calls: \`bun test\` and \`sed -i\` inside the project → allow. \`ssh <the deploy host> 'docker ps; free -h; systemctl status x'\` while carrying out a task the user asked for → allow. \`scp db.sqlite <the host the user named>\` → allow. \`uc deploy <the target the user named>\` → allow. \`ssh <host> 'systemctl start x'\` after the user said to turn it on → allow; without that authorization → ask. \`ssh\` or \`scp\` to a host the user never mentioned → ask. \`litestream restore\` over live production data → ask. \`find / -name …\` → narrow. \`rm -rf /\` → deny.

Prefer allow for ordinary work. Use narrow only when the scope is the problem. Use ask when a human genuinely needs to decide. Use deny only for catastrophic actions.`;

export const CLASSIFIER_CHOICE_CRITERIA = {
  allow:
    "Inside trustedRoots or scratchDir; non-destructive reads of non-sensitive data anywhere, including remote and sudo read-only diagnostics; routine local work; remote/privileged/egress steps that carry out a user-authorized task and name its destinations.",
  narrow:
    "Safe work with the wrong scope: a recursive search or filesystem-wide scan outside the project, or a scratch write aimed at another session's scratch dir. The target, not the data, is the problem.",
  ask:
    "Exceeds the requested task or names a destination the user did not: egress to a new destination (push/deploy/ssh/scp/rsync), a production data write beyond the task, an unauthorized privileged state change (restarting a service, mounting, resizing), a destructive or hard-to-reverse state change, a secret read, or external data transfer.",
  deny:
    "Catastrophic or credential exfiltration: rm -rf /, mkfs, dd of=/dev, shutdown, never run.",
} as const;

// ─── Request construction ──────────────────────────────────────────────────

/** The state a classifier sees. */
export function buildClassifierState(opts: SpawnOpts): Record<string, unknown> {
  const ctx = opts.reviewContext;
  if (!ctx) return { reviewRequest: opts.prompt };
  return {
    projectRoot: ctx.projectRoot,
    plannedAction: ctx.action,
    transcript: ctx.transcript,
    ...(ctx.currentRequest ? { currentRequest: ctx.currentRequest } : {}),
    ...(ctx.trustedRoots?.length ? { trustedRoots: ctx.trustedRoots } : {}),
    ...(ctx.scratchDir ? { scratchDir: ctx.scratchDir } : {}),
    ...(ctx.assistantIntent ? { assistantIntent: ctx.assistantIntent } : {}),
    ...(ctx.retryReason ? { retryReason: ctx.retryReason } : {}),
  };
}

/** The full classifier request: one choice question. Exported for tests. */
export function buildClassifierContext(opts: SpawnOpts) {
  return {
    state: buildClassifierState(opts),
    questions: {
      [CLASSIFIER_CHOICE_IDS.action]: {
        type: "choice" as const,
        instructions: CLASSIFIER_CHOICE_INSTRUCTIONS,
        criteria: CLASSIFIER_CHOICE_CRITERIA,
      },
    },
  };
}

// ─── Model resolution ──────────────────────────────────────────────────────

function modelSpecOf(model: ClassifierModelLike): string | undefined {
  if (!model.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

/** Prefer an explicit classifier model, then the current chain spec, then
 *  `autoApprove.classifierModel`, then the shipped Jev default. */
function configuredSpec(opts: SpawnOpts): string {
  if (opts.modelSpec) return opts.modelSpec;
  const configured = loadAutoApproveConfig().classifierModel;
  if (Array.isArray(configured)) return configured[0] ?? DEFAULT_CLASSIFIER_MODEL;
  return configured ?? DEFAULT_CLASSIFIER_MODEL;
}

function resolveClassifierModel(
  opts: SpawnOpts,
  registry: ClassifierRegistry | undefined,
): { model?: unknown; spec: string; error?: string } {
  const explicit = opts.model as ClassifierModelLike | undefined;
  if (explicit?.type === "classifier") {
    return { model: explicit, spec: modelSpecOf(explicit) ?? configuredSpec(opts) };
  }

  const spec = configuredSpec(opts);
  if (!registry) {
    return { spec, error: "parent context has no model registry" };
  }

  const slash = spec.indexOf("/");
  const provider = slash > 0 ? spec.slice(0, slash) : undefined;
  const id = slash > 0 ? spec.slice(slash + 1) : spec;

  let model: unknown;
  if (provider && registry.findOfType) {
    model = registry.findOfType("classifier", provider, id);
  }
  if (!model) {
    model = registry
      .getModelsOfType?.("classifier", provider)
      ?.find((m) => m.id === id && (!provider || m.provider === provider));
  }
  if (!model) return { spec, error: `classifier model "${spec}" not found in the catalog` };
  return { model, spec };
}

// ─── The classifier reviewer ───────────────────────────────────────────────

function unavailable(message: string): SpawnResult {
  debugLog(`safetynet: classifier reviewer unavailable: ${message}`);
  return {
    content: [{ type: "text" as const, text: "" }],
    details: { error: `classifier reviewer: ${message}`, turnCount: 1, activities: [] },
  };
}

function withDeadline<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    request.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DOMException("classifier review deadline", "TimeoutError")),
        timeoutMs,
      );
    }),
  ]);
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Absolute P(allow) below which a classifier `allow` is never trusted, even
 *  when it wins the ranking outright. */
export const CLASSIFIER_ALLOW_FLOOR = 0.5;

/** How far P(allow) must lead the runner-up before the model's own `allow`
 *  choice is taken at face value. At or below this the options are too close
 *  to call, so the action nudges (narrow) or asks (ask). Strict comparison:
 *  a tie at the boundary goes to the safer branch. */
export const CLASSIFIER_ALLOW_MARGIN = 0.05;

const CHOICES = new Set(["allow", "narrow", "ask", "deny"]);

/** One classifier call decides the permission review. */
export async function spawnClassifierReviewer(opts: SpawnOpts): Promise<SpawnResult> {
  const t0 = Date.now();
  const registry = opts.parentCtx.modelRegistry as unknown as ClassifierRegistry | undefined;
  if (typeof registry?.classify !== "function") {
    return unavailable(
      registry
        ? "model registry exposes no classify() entry point"
        : "parent context has no model registry",
    );
  }

  const resolved = resolveClassifierModel(opts, registry);
  if (resolved.error || !resolved.model) {
    return unavailable(resolved.error ?? "classifier model could not be resolved");
  }

  const threshold =
    typeof opts.classifierThreshold === "number" && Number.isFinite(opts.classifierThreshold)
      ? Math.min(1, Math.max(0, opts.classifierThreshold))
      : loadAutoApproveConfig().classifierThreshold ?? DEFAULT_CLASSIFIER_THRESHOLD;

  const modelInfo = resolved.model as ClassifierModelLike;
  const provider = modelInfo.provider ?? resolved.spec.split("/")[0];
  const apiKey = provider === "typesafe"
    ? process.env.JEV_API_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim()
    : undefined;

  const context = buildClassifierContext(opts);
  const requestOptions = {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(apiKey ? { apiKey, env: { TYPESAFE_API_KEY: apiKey } } : {}),
    maxRetries: 1,
  };

  let result: ClassifierResult;
  try {
    const request = Promise.resolve(registry.classify(resolved.model, context, requestOptions));
    result = (opts.timeoutMs ? await withDeadline(request, opts.timeoutMs) : await request) as ClassifierResult;
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

  const details: Record<string, unknown> = {
    turnCount: 1,
    activities: [],
    model: result.model
      ? result.provider
        ? `${result.provider}/${result.model}`
        : result.model
      : resolved.spec,
    ...(result.usage ? { usage: result.usage } : {}),
  };

  if (result.stopReason === "error") {
    details.error = result.errorMessage || "classifier reviewer: provider error";
    details.classifierMs = Date.now() - t0;
    return { content: [{ type: "text" as const, text: "" }], details };
  }
  if (result.stopReason === "aborted" || opts.signal?.aborted) {
    details.aborted = true;
    details.classifierMs = Date.now() - t0;
    return { content: [{ type: "text" as const, text: "" }], details };
  }

  const answer = result.answers?.[CLASSIFIER_CHOICE_IDS.action];
  const choice = answer?.choice;
  const probabilities = answer?.probabilities ?? {};
  if (typeof choice !== "string" || !CHOICES.has(choice)) {
    details.error = "classifier reviewer: returned no usable action choice";
    details.classifierMs = Date.now() - t0;
    return { content: [{ type: "text" as const, text: "" }], details };
  }
  const probability = probabilities[choice] ?? answer?.confidence ?? 0;

  // A weak `allow` is not automatically an ask. The classifier already chose
  // `allow`; this second-guess exists for genuine coin-flips, so it fires only
  // when a competing option is within ALLOW_MARGIN or the allow itself is below
  // the floor. Measured on the review ledger: 15 of 20 downgraded allows had a
  // decisive margin (e.g. 0.55 allow / 0.44 ask) and were pure prompt noise.
  let effectiveChoice = choice;
  if (choice === "allow" && probability < threshold) {
    const narrowP = probabilities.narrow ?? 0;
    const askP = probabilities.ask ?? 0;
    const runnerUp = Math.max(askP, narrowP);
    const decisive =
      probability >= CLASSIFIER_ALLOW_FLOOR && probability - runnerUp > CLASSIFIER_ALLOW_MARGIN;
    if (!decisive) {
      effectiveChoice = narrowP >= 0.4 && narrowP >= askP ? "narrow" : "ask";
    }
  }

  details.classifier = {
    model: details.model,
    choice: effectiveChoice,
    modelChoice: choice,
    probability,
    probabilities,
    threshold,
    ask: false,
    nudge: false,
    ...(effectiveChoice === choice ? {} : { secondGuessed: true }),
  };
  details.classifierMs = Date.now() - t0;

  if (effectiveChoice === "ask") {
    details.ask = true;
    details.askReason =
      choice === "allow"
        ? `Jev was not confident enough to allow (${pct(probability)} < ${threshold.toFixed(2)})`
        : "Jev requested your approval";
    (details.classifier as Record<string, unknown>).ask = true;
    debugLog(
      `safetynet: classifier ask — ${details.askReason} ${Date.now() - t0}ms`,
    );
    return { content: [{ type: "text" as const, text: "" }], details };
  }

  switch (effectiveChoice) {
    case "allow":
      details.verdict = {
        risk_level: "low",
        user_authorization: "high",
        outcome: "allow",
        rationale: `Jev allowed this action (P=${pct(probability)}).`,
        category: "allow",
      } satisfies ReviewerAssessment;
      break;
    case "narrow":
      details.verdict = {
        risk_level: "medium",
        user_authorization: "unknown",
        outcome: "deny",
        rationale: "This action is too broad. Narrow the target before retrying.",
        category: "narrow",
        nudge: true,
      } satisfies ReviewerAssessment;
      (details.classifier as Record<string, unknown>).nudge = true;
      break;
    case "ask":
      details.ask = true;
      details.askReason = "Jev requested your approval";
      (details.classifier as Record<string, unknown>).ask = true;
      break;
    case "deny":
      details.verdict = {
        risk_level: "critical",
        user_authorization: "unknown",
        outcome: "deny",
        rationale: "This action is catastrophic or would exfiltrate credentials; it will not run.",
        category: "deny",
      } satisfies ReviewerAssessment;
      break;
  }

  debugLog(
    `safetynet: classifier ${choice} — model="${String(details.model)}" p=${pct(probability)} ` +
      `${Date.now() - t0}ms`,
  );
  return { content: [{ type: "text" as const, text: "" }], details };
}