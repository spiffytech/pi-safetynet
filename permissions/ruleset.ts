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
  return picomatch(pattern, { dot: true })(target);
}

function actionForProfile(
  action: PermissionAction,
  modes: ProfileName[] | undefined,
  profile: ProfileName,
): PermissionAction | null {
  if (!modes || modes.length === 0) {
    if (action === "deny") return "deny";
    if (action === "allow") return profile === "plan" ? "deny" : "allow";
    return action;
  }

  if (modes.includes(profile)) return action;

  return null;
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

  for (let i = matching.length - 1; i >= 0; i--) {
    const rule = matching[i]!;
    const effectiveAction = actionForProfile(rule.action, rule.modes, profile);
    if (effectiveAction !== null) {
      return { action: effectiveAction, matchedRule: rule };
    }
  }

  return { action: profile === "plan" ? "deny" : "ask" };
}
