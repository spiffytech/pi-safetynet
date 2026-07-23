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

/** Evaluate a rule against one or two target representations.
 *
 *  The bash parser emits two parallel forms per subcommand: a canonical
 *  (de-quoted) form and a display (quote-preserving) form.  A rule the
 *  user approved may carry quotes (e.g. `curl -s "https://x/*"`), so it must
 *  be matchable against the display form; an unedited/short-arg rule may be
 *  canonical, so it must still match the canonical form.  Passing both forms
 *  here lets either match, without re-parsing (which would break the parser's
 *  own opaque-string placeholders).  `displayTarget` is optional for callers
 *  that only have a single form (e.g. `tool:<name>` targets, file paths). */
export function evaluatePermission(
  permission: PermissionName,
  target: string,
  profile: ProfileName,
  rules: Ruleset,
  displayTarget?: string,
): EvaluateResult {
  const matching = rules.filter((r) => {
    if (r.permission !== permission && r.permission !== "*") return false;
    if (matchesPattern(r.permission, r.pattern, target)) return true;
    if (displayTarget !== undefined && displayTarget !== target && matchesPattern(r.permission, r.pattern, displayTarget)) return true;
    return false;
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
