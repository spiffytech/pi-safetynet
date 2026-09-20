import { resolve } from "node:path";
import type { ProfileName, PermissionAction, Ruleset, ModeAliases } from "./types.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { getBaselineRules } from "./permissions/index.ts";
import { parseCommand, subcommandTokenLists, isHazardousFile, isEditLikeBashCommand } from "./bash-parser.ts";
import { normalizePathForMatching, expandHome } from "./project.ts";
import { patternMatches } from "./inferred/shapes.ts";
import type { InferredBashRule } from "./inferred/store.ts";
/** Device files that are always safe to use as redirect targets. */
const SAFE_DEVICE_FILES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/full",
]);

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
  unapproved?: string[];
  /** Display form of each unapproved subcommand — preserves the user's
   *  original quoting for UI display.  Parallel to `unapproved` (same
   *  length/order). */
  unapprovedDisplay?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  /** True when the deny is caused by a hazardous/sensitive file (e.g. .env,
   *  .ssh, credentials).  Hazardous denials nudge-and-continue up to a per-scope
   *  cap instead of aborting the turn immediately. */
  hazardous?: boolean;
  /** True when the deny is enforced by the active mode (e.g. a bash write in
   *  read-only mode). Lets the deny path label the nudge "Mode denied" and
   *  attach mode-specific recovery guidance. */
  modeDenied?: boolean;
}

/** True when the checked action has write side effects: an edit/write tool
 *  call, or a bash command writing through an output redirect. Mechanical
 *  classification — commands whose writing is only detectable semantically
 *  (git commit, touch, mkdir) are NOT flagged here; the reviewer prompt's
 *  Session-mode rule denies those in read-only sessions. */
export function actionWrites(permission: "bash" | "read" | "edit", check: PermissionCheck): boolean {
  if (permission === "edit") return true;
  if (permission === "bash") {
    return (check.redirectTargets ?? []).some((rt) => rt.permission === "edit");
  }
  return false;
}

export function checkFileTarget(
  filePath: string,
  permission: "read" | "edit",
  profile: ProfileName,
  rules: Ruleset,
  cwd?: string,
  trustExternalPaths = false,
  modeAliases: ModeAliases = {},
): PermissionCheck {
  if (isHazardousFile(filePath)) {
    return { action: "deny", reason: "Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.", hazardous: true };
  }

  if (SAFE_DEVICE_FILES.has(filePath)) {
    return { action: "allow" };
  }

  const absCwd = cwd ?? process.cwd();
  const normalized = normalizePathForMatching(filePath, absCwd);

  const result = evaluatePermission(permission, normalized, profile, rules, undefined, modeAliases);
  if (result.action === "deny") {
    return {
      action: "deny",
      reason: result.matchedRule?.reason ?? "Automatically denied",
    };
  }

  // For external paths, the baseline catch-all rules (e.g. read: ** -> allow)
  // match but should not automatically approve — the user should be asked.
  // However, if an explicit rule matched (e.g. a user-added allow rule for a
  // specific external path, or a user-added ** rule), honour it.
  //
  // External paths are identified by the normalized form: internal paths
  // are "." or relative (e.g. "src/foo.ts"), while external paths remain
  // absolute (e.g. "/etc/passwd") after normalization.
  if (!trustExternalPaths && normalized.startsWith("/")) {
    if (result.action === "allow" && result.matchedRule?.pattern === "**") {
      // Only downgrade when the matched rule came from the baseline —
      // user-added ** rules should be honoured as explicit approvals.
      const baseline = getBaselineRules();
      if (baseline.includes(result.matchedRule)) {
        return { action: "ask", reason: "Path is outside project root" };
      }
    }
  }

  return { action: result.action };
}

/** Check whether a subcommand consists entirely of variable assignments
 *  (e.g. `A=1`, `ORDER_ID=abc`).  Such commands are always safe — they
 *  only set env vars in the current shell context and don't execute any
 *  external command.  Command substitutions within the value (e.g.
 *  `A=$(cmd)`) are extracted as separate subcommands by the parser and
 *  checked independently. */
function isBareAssignment(subcommand: string): boolean {
  const tokens = subcommand.trim().split(/\s+/);
  return tokens.length > 0
    && tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

/**
 * Check whether a subcommand is `cd <path>` where <path> resolves to
 * cwd or a directory below it.  Such commands are always safe and
 * auto-approved. When `trustExternalPaths` is set, cd to ANY directory
 * (including those outside cwd) is auto-approved.
 */
function isCdWithinProject(subcommand: string, cwd: string, trustExternalPaths = false): boolean {
  const trimmed = subcommand.trim();
  if (trimmed === "cd") return true; // bare cd → $HOME, harmless

  const cdMatch = trimmed.match(/^cd\s+(.+)$/);
  if (!cdMatch) return false;

  let target = cdMatch[1]!.trim();

  // Strip quotes
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }

  target = expandHome(target);

  // Resolve relative paths against cwd.
  const resolved = target.startsWith("/") ? target : resolve(cwd, target);

  // Target must be within or equal to cwd. When external paths are
  // trusted, auto-approve cd to any directory.
  return trustExternalPaths || resolved.startsWith(cwd + "/") || resolved === cwd;
}

/** Does an inferred rule apply to this profile? Mirrors the alias-aware
 *  matching of explicit rules. */
function inferredRuleApplies(
  rule: InferredBashRule,
  profile: ProfileName,
  modeAliases: ModeAliases,
): boolean {
  if (rule.modes.includes(profile)) return true;
  for (const [from, to] of Object.entries(modeAliases)) {
    if (to === profile && rule.modes.includes(from as ProfileName)) return true;
  }
  return false;
}

export function checkBashPermission(
  command: string,
  profile: ProfileName,
  rules: Ruleset,
  cwd?: string,
  trustExternalPaths = false,
  modeAliases: ModeAliases = {},
  /** Accepted inferred rules (structural bash patterns). Consulted only
   *  when the explicit ruleset says "ask" — an explicit deny always wins. */
  inferred?: InferredBashRule[],
): PermissionCheck {
  const parsed = parseCommand(command);

  if (parsed.catastrophic) {
    return { action: "deny", reason: "Catastrophic command", unapproved: [] };
  }

  // In read-only modes, deny bash commands that are functionally equivalent
  // to the edit/write tools (which are disabled in read-only modes).
  // This prevents circumvention via heredoc+redirect, sed -i, tee,
  // interpreter -c/-e, etc.
  if ((profile === "plan" || profile === "ro") && isEditLikeBashCommand(command, parsed)) {
    const label = profile === "ro" ? "Read-only mode" : "Plan mode";
    return {
      action: "deny",
      reason: `${label}: bash command writes to a file (equivalent to edit/write tool)`,
      modeDenied: true,
    };
  }

  const unapproved: string[] = [];
  const unapprovedDisplay: string[] = [];
  const redirectTargets: Array<{ permission: "read" | "edit"; path: string }> = [];
  const denyReasons: string[] = [];
  let worstAction: PermissionAction = "allow";
  let hazardous = false;

  const absCwd = cwd ?? process.cwd();

  for (let i = 0; i < parsed.subcommands.length; i++) {
    const sub = parsed.subcommands[i]!;
    // Auto-approve cd when the target is within (or equal to) cwd.
    // cd to the project or a subdirectory is always safe and the LLM
    // frequently emits it as a preamble (e.g. "cd <cwd> && git diff").
    if (isCdWithinProject(sub, absCwd, trustExternalPaths)) continue;

    // Bare variable assignments (e.g. ORDER_ID=abc) are always safe.
    // Command substitutions in values are extracted as separate subcommands.
    if (isBareAssignment(sub)) continue;

    const displaySub = parsed.displaySubcommands[i] ?? sub;
    const result = evaluatePermission("bash", sub, profile, rules, displaySub, modeAliases);
    if (result.action === "deny") {
      worstAction = "deny";
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
      const r = result.matchedRule?.reason ?? "Automatically denied";
      if (!denyReasons.includes(r)) denyReasons.push(r);
    } else if (result.action === "ask") {
      // Inferred rules may settle an ask (structural token match), but never
      // override a deny above.
      const inferredAllow = inferred?.length
        ? inferred.some(
            (r) =>
              inferredRuleApplies(r, profile, modeAliases) &&
              patternMatches(r.pattern, subcommandTokenLists(sub)[0] ?? []),
          )
        : false;
      if (!inferredAllow) {
        if (worstAction !== "deny") worstAction = "ask";
        if (!unapproved.includes(sub)) {
          unapproved.push(sub);
          unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
        }
      }
    }
  }

  for (const target of parsed.redirects) {
    const perm = target.direction === "input" ? "read" : "edit";
    const targetResult = checkFileTarget(target.path, perm, profile, rules, cwd, trustExternalPaths, modeAliases);
    if (targetResult.action === "deny") {
      worstAction = "deny";
      redirectTargets.push({ permission: perm, path: target.path });
      if (targetResult.hazardous) hazardous = true;
      if (targetResult.reason && !denyReasons.includes(targetResult.reason)) {
        denyReasons.push(targetResult.reason);
      }
    } else if (targetResult.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      redirectTargets.push({ permission: perm, path: target.path });
    }
  }

  const result: PermissionCheck = { action: worstAction, unapproved, unapprovedDisplay, redirectTargets };
  if (hazardous) result.hazardous = true;
  if (worstAction === "deny" && denyReasons.length > 0) {
    result.reason = denyReasons.join("; ");
  }
  return result;
}
export function checkToolPermission(
  toolName: string,
  profile: ProfileName,
  rules: Ruleset,
  modeAliases: ModeAliases = {},
  /** Accepted inferred rules (structural patterns). Consulted only when the
   *  explicit ruleset says "ask" — the same contract as checkBashPermission,
   *  so tool calls get the same inferred-rule affordances as bash commands. */
  inferred?: InferredBashRule[],
): PermissionCheck {
  const target = `tool:${toolName}`;
  const result = evaluatePermission("bash", target, profile, rules, undefined, modeAliases);
  if (result.action === "deny") {
    return { action: "deny", reason: result.matchedRule?.reason ?? "Unknown tool denied by ruleset" };
  }
  if (result.action === "ask") {
    const inferredAllow = inferred?.length
      ? inferred.some(
          (r) =>
            inferredRuleApplies(r, profile, modeAliases) &&
            patternMatches(r.pattern, subcommandTokenLists(target)[0] ?? []),
        )
      : false;
    if (inferredAllow) return { action: "allow" };
    return { action: "ask", reason: profile === "plan" ? "Unknown tool in plan mode requires approval" : "Unknown tool in read-only mode requires approval" };
  }
  return { action: result.action };
}
