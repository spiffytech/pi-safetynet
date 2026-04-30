import picomatch from "picomatch";
import type { Rule, Ruleset, PermissionName, PermissionAction, ProfileName } from "../types.js";

export function bashPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withSpaceStarOptional = escaped.replace(/ \*/g, "( .*)?");
  const withWildcard = withSpaceStarOptional.replace(/\*/g, ".*");
  return new RegExp(`^${withWildcard}$`);
}

export function matchesPattern(
  permission: PermissionName,
  pattern: string,
  target: string,
): boolean {
  if (permission === "bash" || permission === "*") {
    return bashPatternToRegex(pattern).test(target);
  }
  return picomatch(pattern)(target);
}

export function getActionForProfile(
  action: PermissionAction,
  modes: ProfileName[] | undefined,
  profile: ProfileName,
): PermissionAction {
  if (action === "deny" && (!modes || modes.length === 0)) {
    return "deny";
  }

  if (action === "allow" && (!modes || modes.length === 0)) {
    return profile === "plan" ? "deny" : "allow";
  }

  if (modes && modes.length > 0) {
    if (modes.includes(profile)) return action;
    if (action === "allow") return "deny";
    if (action === "deny") return "deny";
    if (action === "ask") return profile === "plan" ? "deny" : "ask";
  }

  return action;
}

export interface EvaluateResult {
  action: PermissionAction;
  matchedRule?: Rule;
}

export function evaluatePermission(
  permission: PermissionName | ("bash" | "edit" | "read" | "*")[],
  target: string,
  profile: ProfileName,
  rules: Ruleset,
): EvaluateResult {
  const permArray = Array.isArray(permission) ? permission : [permission];
  const matching = rules.filter((r) => {
    if (!permArray.includes(r.permission) && r.permission !== "*") return false;
    return matchesPattern(r.permission, r.pattern, target);
  });

  const last = matching[matching.length - 1];

  if (!last) {
    return { action: profile === "plan" ? "deny" : "ask" };
  }

  const effectiveAction = getActionForProfile(last.action, last.modes, profile);
  return { action: effectiveAction, matchedRule: last };
}
