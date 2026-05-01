import type { ProfileName, PermissionAction, Ruleset } from "./types.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { parseCommand, isHazardousFile } from "./bash-parser.ts";
import { isExternalPath, normalizePathForMatching, findProjectRoot } from "./project.ts";

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
  unapproved?: string[];
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

  const root = projectRoot ?? findProjectRoot(process.cwd());
  if (isExternalPath(filePath, root)) {
    return { action: "ask", reason: "Path is outside project root" };
  }

  const normalized = normalizePathForMatching(filePath, root);
  const result = evaluatePermission(permission, normalized, profile, rules);
  if (result.action === "deny") {
    const match = result.matchedRule;
    return {
      action: "deny",
      reason: match ? `Denied by rule "${match.pattern}"` : "Denied by ruleset",
    };
  }
  return { action: result.action };
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

  const unapproved: string[] = [];
  let worstAction: PermissionAction = "allow";

  for (const sub of parsed.subcommands) {
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
    } else if (targetResult.action === "ask" && worstAction === "allow") {
      worstAction = "ask";
    }
  }

  return { action: worstAction, unapproved };
}
