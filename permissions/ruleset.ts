import picomatch from "picomatch";
import type { Rule, Ruleset, PermissionName, PermissionAction, ProfileName } from "../types.ts";

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
  // "." represents the project root directory itself.
  // picomatch("**")(".") returns false, but semantically the root
  // IS contained within ** — it is the zero-segment match.
  if (target === "." && pattern === "**") return true;
  return picomatch(pattern, { dot: true })(target);
}

function actionForProfile(
  action: PermissionAction,
  modes: ProfileName[],
  profile: ProfileName,
): PermissionAction | null {
  if (modes.includes(profile)) return action;
  return null;
}

export interface EvaluateResult {
  action: PermissionAction;
  matchedRule?: Rule;
}

export function evaluatePermission(
  permission: PermissionName,
  target: string,
  profile: ProfileName,
  rules: Ruleset,
): EvaluateResult {
  const matching = rules.filter((r) => {
    if (r.permission !== permission && r.permission !== "*") return false;
    return matchesPattern(r.permission, r.pattern, target);
  });

  for (let i = matching.length - 1; i >= 0; i--) {
    const rule = matching[i]!;
    const effectiveAction = actionForProfile(rule.action, rule.modes, profile);
    if (effectiveAction !== null) {
      return { action: effectiveAction, matchedRule: rule };
    }
  }

  if (rules.length === 0) return { action: "deny" };
  return { action: "ask" };
}
