import { resolve } from "node:path";
import type { ProfileName, PermissionAction, Ruleset } from "./types.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { parseCommand, isHazardousFile, isEditLikeBashCommand } from "./bash-parser.ts";
import { isExternalPath, normalizePathForMatching } from "./project.ts";

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
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
}

export function checkFileTarget(
  filePath: string,
  permission: "read" | "edit",
  profile: ProfileName,
  rules: Ruleset,
  projectRoot?: string,
): PermissionCheck {
  if (isHazardousFile(filePath)) {
    return { action: "deny", reason: "Hazardous file (e.g., .env, .ssh, credentials)" };
  }

  if (SAFE_DEVICE_FILES.has(filePath)) {
    return { action: "allow" };
  }

  const root = projectRoot ?? process.cwd();
  const normalized = normalizePathForMatching(filePath, root);

  const result = evaluatePermission(permission, normalized, profile, rules);
  if (result.action === "deny") {
    const match = result.matchedRule;
    return {
      action: "deny",
      reason: match ? `Denied by rule "${match.pattern}"` : "Denied by ruleset",
    };
  }

  // For external paths, the baseline catch-all rules (e.g. read: ** -> allow)
  // match but should not automatically approve — the user should be asked.
  // However, if an explicit non-catch-all rule matched (e.g. a user-added
  // allow rule for a specific external path), honour it.
  if (isExternalPath(filePath, root)) {
    if (result.action === "allow" && result.matchedRule?.pattern === "**") {
      return { action: "ask", reason: "Path is outside project root" };
    }
  }

  return { action: result.action };
}

/**
 * Check whether a subcommand is `cd <path>` where <path> resolves to
 * the project root or a directory below it.  Such commands are always
 * safe and auto-approved.
 */
function isCdWithinProject(subcommand: string, projectRoot: string): boolean {
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

  // Handle ~ expansion
  if (target.startsWith("~")) {
    target = (process.env.HOME ?? "/home") + target.slice(1);
  }

  // Resolve relative paths against the project root (not cwd),
  // since the agent's cwd should be within the project.
  const resolved = target.startsWith("/") ? target : resolve(projectRoot, target);

  // Target must be within or equal to the project root
  return resolved.startsWith(projectRoot + "/") || resolved === projectRoot;
}

export function checkBashPermission(
  command: string,
  profile: ProfileName,
  rules: Ruleset,
  projectRoot?: string,
): PermissionCheck {
  const parsed = parseCommand(command);

  if (parsed.catastrophic) {
    return { action: "deny", reason: "Catastrophic command", unapproved: [] };
  }

  // In plan mode, deny bash commands that are functionally equivalent
  // to the edit/write tools (which are disabled in plan mode).
  // This prevents circumvention via heredoc+redirect, sed -i, tee,
  // interpreter -c/-e, etc.
  if (profile === "plan" && isEditLikeBashCommand(command, parsed)) {
    return { action: "deny", reason: "Plan mode: bash command writes to a file (equivalent to edit/write tool)" };
  }

  const unapproved: string[] = [];
  const redirectTargets: Array<{ permission: "read" | "edit"; path: string }> = [];
  let worstAction: PermissionAction = "allow";

  const root = projectRoot ?? process.cwd();

  for (const sub of parsed.subcommands) {
    // Auto-approve cd when the target is within (or equal to) the project root.
    // cd to the project or a subdirectory is always safe and the LLM
    // frequently emits it as a preamble (e.g. "cd <cwd> && git diff").
    if (isCdWithinProject(sub, root)) continue;

    const result = evaluatePermission("bash", sub, profile, rules);
    if (result.action === "deny") {
      worstAction = "deny";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    } else if (result.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    }
  }

  for (const target of parsed.redirects) {
    const perm = target.direction === "input" ? "read" : "edit";
    const targetResult = checkFileTarget(target.path, perm, profile, rules, projectRoot);
    if (targetResult.action === "deny") {
      worstAction = "deny";
      redirectTargets.push({ permission: perm, path: target.path });
    } else if (targetResult.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      redirectTargets.push({ permission: perm, path: target.path });
    }
  }

  return { action: worstAction, unapproved, redirectTargets };
}
