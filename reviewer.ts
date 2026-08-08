/**
 * reviewer.ts — spawns a permission-review subagent and classifies the result.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewVerdict, ReviewerAssessment } from "./types.ts";
import type { PermissionCheck } from "./check.ts";
import {
  REVIEWER_SYSTEM_PROMPT,
  formatActionJson,
  parseAssessment,
  compactTranscript,
  type ActionJsonOpts,
  type TranscriptEntry,
} from "./reviewer-prompt.ts";

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

/** Reset all state for tests. */
export function resetReviewStateForTests(): void {
  consecutiveDenies = 0;
  turnToken = 0;
  reviewActive = false;
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
  parentCtx: ExtensionContext;
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
  parentCtx: ExtensionContext;
  /** Profile string for action JSON (plan/build). */
  profile: string;
  signal?: AbortSignal;
  timeoutMs: number;
  retryReason?: string;
}

/** Run a permission review and classify the result. */
export async function runPermissionReview(
  opts: ReviewCallOpts,
  deps: ReviewDeps,
): Promise<ReviewVerdict> {
  // Build transcript from parent session entries
  let transcriptStr = "(no transcript available)";
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
  } catch {
    // If we can't build the transcript, proceed without one
  }

  // Build action JSON
  const actionOpts: ActionJsonOpts = {
    permission: opts.permission,
    target: opts.target,
    cwd: opts.cwd,
    ...(opts.check.unapproved ? { subcommands: opts.check.unapproved } : {}),
    ...(opts.check.redirectTargets ? { redirectTargets: opts.check.redirectTargets } : {}),
    profile: opts.profile,
  };
  const actionJson = formatActionJson(actionOpts);

  // Build task prompt
  let taskPrompt = `## Transcript\n${transcriptStr}\n\n## Planned action\n${actionJson}\n\nReturn strict JSON only.`;
  if (opts.retryReason) {
    taskPrompt = `## Retry reason\n${opts.retryReason}\n\n${taskPrompt}`;
  }

  // Run the reviewer subagent
  const result = await deps.spawn({
    taskType: "explore",
    prompt: taskPrompt,
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs,
    parentCtx: opts.parentCtx,
    cwd: opts.cwd,
    trustExternalPaths: true,
  });

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