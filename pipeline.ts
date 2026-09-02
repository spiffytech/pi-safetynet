/**
 * pipeline.ts — shared permission pipeline.
 *
 * The single implementation of "resolve this permission check",
 * parameterized by site-specific deltas so both the main session
 * (index.ts) and bridged subagent (subagent-safetynet.ts) share
 * one ask-allow-deny loop.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Rule, Ruleset, TempRule, ProfileName, PermissionAction, AutoDenyConfig,
} from "./core/types.ts";
import type { PermissionPromptOptions, PermissionPromptResult, PermissionDuration } from "./prompts.ts";
import type { PromptKeybindings } from "./core/types.ts";
import { showPermissionPrompt } from "./prompts.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./core/project.ts";
import { PermissionStorage } from "./core/permissions/index.ts";
import type { PermissionCheck } from "./core/check.ts";
import { actionWrites } from "./core/check.ts";
import { isAutoEnabled, loadAutoApproveConfig, setAutoEnabled } from "./core/auto-config-state.ts";
import {
  runPermissionReview, reviewConsecutiveDenies, reviewResetDenies,
  reviewIncrementDenies, reviewTurnToken, reviewBumpTurnToken,
  reviewIsActive, reviewSetActive,
  getPendingAutoResult, clearPendingAutoResult, setPendingAutoResult,
  resetReviewStateForTests,
} from "./core/reviewer-state.ts";

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface PipelineDeps {
  /** Where prompts + notifies render (main ctx, or parentCtx for bridged). */
  displayCtx: ExtensionContext;
  /** Primary permission storage. */
  storage: PermissionStorage;
  /** Additional storages receiving the same rules (bridged: [subagent, parent]). */
  dualWrite?: PermissionStorage[];
  /** Called when non-once, non-turn session rules are created (index.ts only). */
  appendSessionRules?: (rules: Ruleset, cwd: string) => void;
  cwd: string;
  /** Rule modes keyed on profile: ["plan","build"] in plan, ["build"] in build. */
  allowModes: ProfileName[];
  /** Extra abort on deny (bridged: also kill the subagent). */
  onDenied?: () => void;
  keybindings: PromptKeybindings;
  autoDeny: AutoDenyConfig;
  /** Send the hidden "manual approval" nudge to the model. Called with the
   *  ExtensionAPI.sendMessage of the session whose tool call was reviewed. */
  sendManualApproval: () => void;
  /** Send the hidden "auto-approval" nudge (auto-reviewer allowed the action). */
  sendAutoApproval?: (risk: string, auth: string) => void;
  /** Deliver auto/ruleset denials to the session model. "hidden" = display:false
   *  nudge that survives aborts; "visible" = display:true transcript entry for
   *  abort paths where the block reason is swallowed by the harness. */
  sendDenial?: (text: string, mode: "hidden" | "visible") => void;
  /** Per-scope hazardous-deny counter. Main session and each subagent get their
   *  own (parallel subagents must not share the parent's counter). Resets on
   *  agent_end. Absent → fresh { count: 0 } (test ergonomics). */
  hazardousDenyState?: HazardousDenyState;
  /** Reviewer subagent spawner. Defaults to runSubagent; injectable for tests. */
  reviewSpawn?: (opts: any) => Promise<any>;
  /** Optional abort signal to pass into the prompt loop (auto escalation). */
  promptAbortSignal?: AbortSignal;
  /** Optional reason text to show in the prompt header (auto escalation). */
  promptReason?: string;
}

// ─── Pure seams ────────────────────────────────────────────────────────────

/** Cap on hazardous-file denials per turn (per scope). The 3rd hazardous deny
 *  aborts the turn, stopping loophole-hunting while still letting the model
 *  course-correct on the first two. */
export const HAZARDOUS_MAX_DENIES = 3;

/** Per-scope hazardous-deny counter. */
export interface HazardousDenyState {
  count: number;
}

/** Resolve a deny verdict. Hazardous denials nudge-and-continue up to
 *  HAZARDOUS_MAX_DENIES per scope, then abort. Non-hazardous denials keep
 *  historical behavior (abort unless autoDeny.continue). */
export function resolveDeny(opts: {
  permission: "bash" | "read" | "edit";
  target: string;
  reason: string;
  hazardous: boolean;
  autoDeny: AutoDenyConfig;
  displayCtx: { abort(): void };
  sendDenial: ((text: string, mode: "hidden" | "visible") => void) | undefined;
  onDenied: (() => void) | undefined;
  state: HazardousDenyState;
}): { block: boolean; reason: string } {
  const detail = denialDetail(opts.permission, opts.target, opts.reason, "ruleset");

  if (opts.hazardous) {
    opts.state.count++;
    opts.sendDenial?.(detail, "hidden");
    if (opts.state.count >= HAZARDOUS_MAX_DENIES) {
      opts.sendDenial?.(detail, "visible");
      opts.displayCtx.abort();
      opts.onDenied?.();
    }
    return { block: true, reason: detail };
  }

  // Non-hazardous: historical behavior.
  opts.sendDenial?.(detail, "hidden");
  if (!opts.autoDeny.continue) {
    opts.sendDenial?.(detail, "visible");
    opts.displayCtx.abort();
    opts.onDenied?.();
  }
  return { block: true, reason: detail };
}

/** Check headless-mode deny behavior. Pure function for testability. */
export function headlessDeny(
  hasUI: boolean,
  action: PermissionAction,
  permission: "bash" | "read" | "edit",
  autoDenyReason?: string,
): { block: boolean; reason: string } | undefined {
  if (hasUI || action !== "ask") return undefined;
  const label = permission[0]!.toUpperCase() + permission.slice(1);
  const reason = autoDenyReason || `${label} requires approval (headless mode)`;
  return { block: true, reason };
}

/** Map a permission-prompt result to a block decision. */
export function denyResultFromPrompt(
  result: PermissionPromptResult | null,
  permission: "bash" | "read" | "edit",
): { block: true; reason: string; abort: boolean } | undefined {
  if (result === null) {
    return { block: true, reason: `User denied ${permission}`, abort: true };
  }
  if (result.kind === "deny") {
    const explanation = result.explanation.trim();
    const reason = explanation || `User denied ${permission}`;
    return { block: true, reason, abort: false };
  }
  return undefined;
}

/** Source of a denial, used to label the surfaced line. */
export type DenialSource = "reviewer" | "ruleset" | "headless" | "mode";

/** Build a self-contained, human-readable denial line: what was denied and why.
 *  risk_level / user_authorization stay internal to the reviewer decision —
 *  the model and user only see the target and the reason. */
export function denialDetail(
  permission: "bash" | "read" | "edit",
  target: string,
  reason: string,
  source: DenialSource = "reviewer",
): string {
  const label =
    source === "reviewer" ? "Auto-denied" :
    source === "ruleset" ? "Ruleset denied" :
    source === "mode" ? "Mode denied" : "Denied";
  return `${label} ${permission}: ${target} — ${reason}`;
}

/** Build a turn-expiry temp rule from checked arguments. */
export function makeTempRule(
  permission: "bash" | "read" | "edit",
  pattern: string,
  modes: ProfileName[],
): TempRule {
  return {
    rule: { permission, pattern, action: "allow" as const, modes },
    expiry: { type: "turn" as const },
  };
}

// ─── Temp-rule building shared with the auto branch ────────────────────────

/** Build the complete list of temp rules for a reviewer allow verdict.
 *  Mirrors what the interactive path builds from approve results.
 *  `target` is the raw permission target (the file path for read/edit
 *  tool calls); for file permissions with no unapproved subcommands or
 *  redirect targets it produces the single file rule needed to satisfy
 *  the post-approval recheck. */
export function buildApprovalRules(
  check: PermissionCheck,
  permission: "bash" | "read" | "edit",
  cwd: string,
  modes: ProfileName[],
  target?: string,
): TempRule[] {
  const rules: TempRule[] = [];
  // One bash rule per unapproved subcommand (canonical form)
  if (check.unapproved) {
    for (const sub of check.unapproved) {
      rules.push(makeTempRule(permission, sub, modes));
    }
  }
  // One read/edit rule per redirect target
  if (check.redirectTargets) {
    for (const rt of check.redirectTargets) {
      rules.push(makeTempRule(rt.permission, toRecursiveGlob(normalizePathForMatching(rt.path, cwd)), modes));
    }
  }
  // Plain read/edit/write tool call: check.unapproved and redirectTargets
  // are both absent. Without this the reviewer's allow would create no
  // rules and the post-approval recheck would still return "ask",
  // degrading an honest auto-approval into the transient→prompt→abort
  // loop. Approve the file itself, mirroring the interactive prompt's
  // file-pattern construction.
  if (rules.length === 0 && target && (permission === "read" || permission === "edit")) {
    rules.push(makeTempRule(permission, toRecursiveGlob(normalizePathForMatching(target, cwd)), modes));
  }
  return rules;
}

/** Deny a mechanically-classifiable write in a read-only session: no reviewer
 *  call, no temp rules. Mirrors resolveDeny's non-hazardous path but labels the
 *  denial as mode-enforced ("Mode denied") and never counts toward the
 *  reviewer circuit-breaker — a read-only session repeatedly attempting writes
 *  must not disable auto-approve. */
function readOnlyWriteDeny(
  deps: PipelineDeps,
  permission: "bash" | "read" | "edit",
  target: string,
): { block: true; reason: string } {
  const reason = "read-only mode prevents writes — switch to write mode to implement";
  const detail = denialDetail(permission, target, reason, "mode");
  deps.sendDenial?.(detail, "hidden");
  if (!deps.autoDeny.continue) {
    deps.sendDenial?.(detail, "visible");
    deps.displayCtx.abort();
    deps.onDenied?.();
  }
  return { block: true, reason: detail };
}

// ─── Shared pipeline ───────────────────────────────────────────────────────

export async function resolvePermission(
  deps: PipelineDeps,
  opts: {
    permission: "bash" | "read" | "edit";
    target: string;
    check: PermissionCheck;
    recheck: () => PermissionCheck;
  },
): Promise<{ block: boolean; reason: string } | undefined> {
  const { action } = opts.check;

  /** Canonical ro/rw mode for the review profile. Read-only sessions (plan/ro)
   *  always review as "ro" so the reviewer enforces its read-only rules. */
  const reviewProfile =
    deps.allowModes.includes("plan") || deps.allowModes.includes("ro") ? "ro" : "rw";

  /** Read-only mode enforcement: never auto-approve a write in a read-only
   *  session. Mechanically-classifiable writes (edit tool, output redirects)
   *  are denied outright — no reviewer call, no temp rules (a reviewer
   *  hallucinate must not mint a write allow in ro mode). Writes only the
   *  reviewer can spot (git commit, touch, mkdir) are covered by the prompt's
   *  Session-mode rule. */
  const rejectWriteInReadOnly = (): { block: true; reason: string } | undefined => {
    if (reviewProfile === "ro" && actionWrites(opts.permission, opts.check)) {
      return readOnlyWriteDeny(deps, opts.permission, opts.target);
    }
    return undefined;
  };

  // ── Allow / Deny short-circuits ──────────────────────────────────────────
  if (action === "allow") return undefined;

  if (action === "deny") {
    const label = opts.permission[0]!.toUpperCase() + opts.permission.slice(1);
    const reason = opts.check.reason
      ?? deps.autoDeny.reason
      ?? `${label} denied: no matching allow rule`;
    return resolveDeny({
      permission: opts.permission,
      target: opts.target,
      reason,
      hazardous: opts.check.hazardous ?? false,
      autoDeny: deps.autoDeny,
      displayCtx: deps.displayCtx,
      sendDenial: deps.sendDenial,
      onDenied: deps.onDenied,
      state: deps.hazardousDenyState ?? { count: 0 },
    });
  }

  // ── Auto-review block (runs BEFORE headless check per T13) ───────────────
  if (action === "ask" && isAutoEnabled() && !reviewIsActive()) {
    // Read-only mode short-circuit: reject writes before the reviewer runs.
    const modeDenied = rejectWriteInReadOnly();
    if (modeDenied) return modeDenied;

    const config = loadAutoApproveConfig();
    const timeoutMs = config.timeoutMs ?? 90000;
    const maxDenials = config.maxDenials ?? 3;
    const retryIntervalMs = config.retryIntervalMs ?? 30000;
    const maxRetries = config.maxRetries ?? 2;

    // One-shot review attempt
    const ctl = new AbortController();
    const token = reviewTurnToken();
    reviewSetActive(true);

    try {
      let v = await Promise.race([
        runPermissionReview(
          {
            permission: opts.permission,
            target: opts.target,
            check: opts.check,
            cwd: deps.cwd,
            parentCtx: deps.displayCtx,
            profile: reviewProfile,
            signal: ctl.signal,
            timeoutMs,
            ...(config.model ? { model: config.model } : {}),
          },
          { spawn: deps.reviewSpawn ?? (await import("./subagent.ts").then((m) => m.runSubagent)) },
        ),
        new Promise<any>((_, reject) =>
          setTimeout(() => { ctl.abort(); reject(new Error("reviewer timeout")); }, timeoutMs)
        ),
      ]);
      ctl.abort(); // kill any straggler session
      reviewSetActive(false);

      // Check turn token
      if (token !== reviewTurnToken()) {
        return { block: true, reason: "Turn ended" };
      }

      if (v.kind === "assessment" && v.assessment.outcome === "allow") {
        // Approve
        reviewResetDenies();
        const tempRules = buildApprovalRules(opts.check, opts.permission, deps.cwd, deps.allowModes, opts.target);
        const allStorages = [deps.storage, ...(deps.dualWrite ?? [])];
        for (const s of allStorages) s.addTempRules(tempRules);

        const recheckResult = opts.recheck();
        if (recheckResult.action === "allow") {
          deps.displayCtx.ui.notify(` Reviewer allowed (risk: ${v.assessment.risk_level}, auth: ${v.assessment.user_authorization})`, "info");
          deps.sendAutoApproval?.(v.assessment.risk_level, v.assessment.user_authorization);
          return undefined;
        }
        // Recheck didn't agree — treat as transient
        v = { kind: "transient" as const, message: "approval rules did not satisfy recheck" };
      }

      if (v.kind === "assessment" && v.assessment.outcome === "deny") {
        // Deny
        deps.displayCtx.ui.notify(` Reviewer denied: ${v.assessment.rationale}`, "warning");
        const denies = reviewIncrementDenies();
        const detail = denialDetail(opts.permission, opts.target, v.assessment.rationale);
        deps.sendDenial?.(detail, "hidden");
        if (denies >= maxDenials) {
          deps.sendDenial?.(detail, "visible");
          deps.displayCtx.abort();
          deps.onDenied?.();
        }
        return { block: true, reason: detail };
      }

      // Fatal — config broken, disable auto
      if (v.kind === "fatal") {
        deps.displayCtx.ui.notify(` Disabling auto-approve: ${v.message}`, "error");
        setAutoEnabled(false, { appendEntry: () => {} } as any); // silent clear
        // Fall through to normal prompt
      }

      // Transient — start background retries and fall through to prompt
      if (v.kind === "transient") {
        const promptCtl = new AbortController();
        let retriesDone = 0;
        clearPendingAutoResult();
        const retryInterval = setInterval(async () => {
          if (retriesDone >= maxRetries) { clearInterval(retryInterval); return; }
          retriesDone++;
          const verdict = await runPermissionReview(
            { permission: opts.permission, target: opts.target, check: opts.check, cwd: deps.cwd, parentCtx: deps.displayCtx, profile: reviewProfile, timeoutMs, ...(config.model ? { model: config.model } : {}) },
            { spawn: deps.reviewSpawn ?? (await import("./subagent.ts").then((m) => m.runSubagent)) },
          ).catch(() => ({ kind: "transient" as const, message: "retry failed" }));
          if (verdict.kind === "assessment") {
            clearPendingAutoResult();
            // STORE verdict first, THEN abort the prompt
            setPendingAutoResult(verdict);
            promptCtl.abort(); // dismiss the prompt — done(null) fires, pipeline checks getPendingAutoResult
          }
        }, retryIntervalMs);

        deps = { ...deps, promptAbortSignal: promptCtl.signal, promptReason: ` Auto-review unavailable (${v.message}); background retries active. Decide manually or wait.` };
      }
    } catch {
      reviewSetActive(false);
      // On any unexpected error, fall through to normal prompt
    }
  }

  // ── Headless ─────────────────────────────────────────────────────────────
  const denied = headlessDeny(deps.displayCtx.hasUI, action, opts.permission, deps.autoDeny.reason);
  if (denied) {
    if (!deps.displayCtx.hasUI) console.error(`safetynet: ${denied.reason}`);
    deps.sendDenial?.(denialDetail(opts.permission, opts.target, denied.reason, "headless"), "hidden");
    if (!deps.autoDeny.continue) deps.displayCtx.abort();
    return denied;
  }

  // ── Interactive prompt loop ──────────────────────────────────────────────
  const isFile = opts.permission === "read" || opts.permission === "edit";
  let reprompt = false;

  while (true) {
    const promptOpts: PermissionPromptOptions = {
      permission: opts.permission,
      target: opts.target,
      reprompt,
      keybindings: deps.keybindings,
    };
    if (opts.check.unapproved && opts.check.unapproved.length > 0) promptOpts.unapproved = opts.check.unapproved;
    if (opts.check.unapprovedDisplay && opts.check.unapprovedDisplay.length > 0) promptOpts.unapprovedDisplay = opts.check.unapprovedDisplay;
    if (opts.check.redirectTargets?.length) promptOpts.redirectTargets = opts.check.redirectTargets;
    if (deps.promptReason) {
      promptOpts.reason = deps.promptReason;
    } else if (opts.check.reason) {
      promptOpts.reason = opts.check.reason;
    }
    if (deps.promptAbortSignal) promptOpts.abortSignal = deps.promptAbortSignal;

    const result = await showPermissionPrompt(deps.displayCtx, promptOpts);

    // A null prompt result is ambiguous between two very different situations:
    //  (a) the user pressed the deny-abort key (Esc) — deny and abort the turn;
    //  (b) the background auto-review retry resolved while the prompt was open,
    //      which aborts the prompt controller (promptCtl.abort()) and resolves
    //      the prompt with null. In case (b) a pending verdict exists and must
    //      be processed BEFORE the null is mistaken for a user deny-abort —
    //      otherwise a successful auto-approval kills the whole turn with
    //      "Operation aborted" (regression: session 019fd4a1 write aborts).
    if (result === null) {
      const pending = getPendingAutoResult();
      if (pending && pending.kind === "assessment") {
        clearPendingAutoResult();
        if (pending.assessment.outcome === "allow") {
          // A background-retry verdict can land after the session flipped to
          // read-only; never mint write temp rules from it either.
          const modeDenied = rejectWriteInReadOnly();
          if (modeDenied) return modeDenied;
          reviewResetDenies();
          const tempRules = buildApprovalRules(opts.check, opts.permission, deps.cwd, deps.allowModes, opts.target);
          const allStorages = [deps.storage, ...(deps.dualWrite ?? [])];
          for (const s of allStorages) s.addTempRules(tempRules);
          const r = opts.recheck();
          if (r.action === "allow") {
            deps.displayCtx.ui.notify(` Reviewer allowed (risk: ${pending.assessment.risk_level}, auth: ${pending.assessment.user_authorization})`, "info");
            deps.sendAutoApproval?.(pending.assessment.risk_level, pending.assessment.user_authorization);
            return undefined;
          }
          return { block: true, reason: "Auto-approval rules did not satisfy recheck" };
        } else {
          const cfg = loadAutoApproveConfig();
          deps.displayCtx.ui.notify(` Reviewer denied: ${pending.assessment.rationale}`, "warning");
          const denies = reviewIncrementDenies();
          const detail = denialDetail(opts.permission, opts.target, pending.assessment.rationale);
          deps.sendDenial?.(detail, "hidden");
          if (denies >= (cfg.maxDenials ?? 3)) {
            deps.sendDenial?.(detail, "visible");
            deps.displayCtx.abort(); deps.onDenied?.();
          }
          return { block: true, reason: detail };
        }
      }
      // No pending auto verdict and the prompt was dismissed (Esc / abort):
      // this is a genuine user deny-abort. denyResultFromPrompt(null) always
      // yields { block: true, abort: true }, so this path always returns.
      const d0 = denyResultFromPrompt(null, opts.permission)!;
      if (d0.abort) deps.displayCtx.abort();
      deps.onDenied?.();
      return { block: d0.block, reason: d0.reason };
    }

    // Deny outcomes: typed deny-with-reason (result is non-null here).
    const d = denyResultFromPrompt(result, opts.permission);
    if (d) {
      if (d.abort) {
        deps.displayCtx.abort();
        deps.onDenied?.();
      } else {
        deps.onDenied?.();
      }
      return { block: d.block, reason: d.reason };
    }
    if (result.kind === "deny") {
      return { block: true, reason: `User denied ${opts.permission}` };
    }
    // Narrowed to the approve type
    const { approved, skipped, skippedDisplay, duration } = result as PermissionPromptResult & { kind: "approve"; approved: Map<string, string>; skipped: string[]; skippedDisplay: string[]; duration: PermissionDuration };

    // "once" — approve for this invocation only; no rules created
    if (duration === "once") {
      if (skipped.length > 0) {
        const remainingRedirects = opts.check.redirectTargets?.filter(
          (rt) => skipped.includes(rt.path),
        );
        const newCheck: PermissionCheck = {
          ...opts.check,
          unapproved: skipped,
          unapprovedDisplay: skippedDisplay,
          action: "ask",
        };
        if (remainingRedirects && remainingRedirects.length > 0) {
          newCheck.redirectTargets = remainingRedirects;
        }
        opts.check = newCheck;
        reprompt = true;
        continue;
      }
      deps.sendManualApproval();
      return undefined;
    }

    // Build rules from approved items
    const redirectOriginals = new Set(opts.check.redirectTargets?.map((rt) => rt.path) ?? []);
    const patterns: string[] = [];
    for (const [original, edited] of approved) {
      if (redirectOriginals.has(original)) continue;
      if (isFile) {
        patterns.push(toRecursiveGlob(normalizePathForMatching(edited, deps.cwd)));
      } else {
        patterns.push(edited);
      }
    }

    const redirectPatterns: Array<{ permission: "read" | "edit"; pattern: string }> = [];
    if (opts.check.redirectTargets?.length) {
      for (const rt of opts.check.redirectTargets) {
        if (approved.has(rt.path)) {
          const editedPath = approved.get(rt.path)!;
          redirectPatterns.push({
            permission: rt.permission,
            pattern: toRecursiveGlob(normalizePathForMatching(editedPath, deps.cwd)),
          });
        }
      }
    }

    const allStorages = [deps.storage, ...(deps.dualWrite ?? [])];

    if (duration === "session" || duration === "project" || duration === "global") {
      const newRules: Ruleset = patterns.map((p) => ({
        permission: opts.permission as Rule["permission"],
        pattern: p,
        action: "allow" as const,
        modes: deps.allowModes,
      }));
      for (const rp of redirectPatterns) {
        newRules.push({
          permission: rp.permission,
          pattern: rp.pattern,
          action: "allow" as const,
          modes: deps.allowModes,
        });
      }

      for (const s of allStorages) {
        if (duration === "project") {
          await s.addPersistedRules(newRules);
        } else if (duration === "global") {
          await s.addGlobalRules(newRules);
        } else {
          s.addSessionRules(newRules);
        }
      }

      if (duration === "session" && deps.appendSessionRules) {
        deps.appendSessionRules(newRules, deps.cwd);
      }
    } else {
      // "turn"
      const tempRules: TempRule[] = patterns.map((p) =>
        makeTempRule(opts.permission, p, deps.allowModes),
      );
      for (const rp of redirectPatterns) {
        tempRules.push(makeTempRule(rp.permission, rp.pattern, deps.allowModes));
      }

      for (const s of allStorages) {
        s.addTempRules(tempRules);
      }
    }

    // Recheck
    const recheckResult = opts.recheck();
    opts.check = recheckResult;
    deps.sendManualApproval();
    if (recheckResult.action === "allow") return undefined;
    if (recheckResult.action === "deny") {
      deps.displayCtx.ui.notify("Rule(s) added but still denied.", "warning");
      return { block: true, reason: "Still denied after rule update" };
    }

    reprompt = true;
  }
}
