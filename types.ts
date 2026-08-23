export type ProfileName = "plan" | "build" | "ro" | "rw";
export type PermissionAction = "allow" | "deny" | "ask";
export type PermissionName = "bash" | "edit" | "read" | "*";

export interface Rule {
  permission: PermissionName;
  pattern: string;
  action: PermissionAction;
  modes: ProfileName[];
  reason?: string;
}

export type Ruleset = Rule[];

/** Which pair of modes the extension currently presents: plan/build or ro/rw. */
export type Paradigm = "plan-build" | "ro-rw";

/** Partial mapping of mode names to their aliases in the other paradigm. */
export type ModeAliases = Partial<Record<ProfileName, ProfileName>>;

/** Expiry policy for a temporary approval rule. */
export type TempExpiry = { type: "turn" };


/** A rule with a temporary lifespan. */
export interface TempRule {
  rule: Rule;
  expiry: TempExpiry;
}

/** Configurable prompt keybindings (key identifiers as understood by
 * pi-tui's `matchesKey`, e.g. "n", "shift+n", "escape", "ctrl+c").
 * Uppercase letters cannot be expressed as a bare capital (pi-tui lowercases
 * single-char ids); use the shifted form, e.g. "shift+n" for N. */
export interface KeybindingsConfig {
  /** Single-key deny-and-continue: block the call, surface the reason to
   *  the model, but keep its turn. No default (opt-in). */
  denyContinue?: string;
  /** Single-key deny-and-abort: block the call and end the turn. Default
   *  "escape". To make Escape a no-op, bind this to something else. */
  denyAbort?: string;
}

/** Auto-deny behaviour for rule-denies and headless (no-TUI) denials. */
export interface AutoDenyConfig {
  /** When true, auto-deny blocks the call WITHOUT aborting the turn (the model
   *  sees the reason and may keep reacting). Default false (abort). */
  continue?: boolean;
  /** Reason surfaced to the model on auto-deny. Per-rule `reason` still takes
   *  precedence when present (more specific). */
  reason?: string;
}

/** JSON contract returned by the permission reviewer subagent. */
export interface ReviewerAssessment {
  risk_level: "low" | "medium" | "high" | "critical";
  user_authorization: "unknown" | "low" | "medium" | "high";
  outcome: "allow" | "deny";
  rationale: string;
}

/** Classified result of a review attempt. */
export type ReviewVerdict =
  | { kind: "assessment"; assessment: ReviewerAssessment }
  | { kind: "transient"; message: string }
  | { kind: "fatal"; message: string };

export interface AutoApproveConfig {
  model?: string;
  timeoutMs?: number;
  maxDenials?: number;
  retryIntervalMs?: number;
  maxRetries?: number;
}