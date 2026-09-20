export type ProfileName = "plan" | "build" | "ro" | "rw";
export type PermissionAction = "allow" | "deny" | "ask";

/** Approval lifetime chosen at the permission prompt. Shared by both frontends. */
export type PermissionDuration = "once" | "turn" | "session" | "project" | "global";
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

/** Auto-deny behaviour for rule/mode/headless denials. Denials nudge-and-
 *  continue up to `maxStrikes` per turn (per scope) before the turn aborts. */
export interface AutoDenyConfig {
  /** When true, auto-deny blocks the call WITHOUT ever aborting the turn, no
   *  matter how many strikes accumulate (the model sees the reason and may
   *  keep reacting). Default false (abort once `maxStrikes` is reached). */
  continue?: boolean;
  /** Strikes per turn (per scope) allowed before the turn aborts. Every strike
   *  sends a hidden nudge to the model; the aborting strike also renders a
   *  visible transcript entry. Default 3. Ignored when `continue` is true. */
  maxStrikes?: number;
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
  /** Reviewer model. Single spec or a fallback list — tried in order until
   *  one produces a verdict. Kept as `model` for backward compatibility. */
  model?: string | string[];
  timeoutMs?: number;
  maxDenials?: number;
  retryIntervalMs?: number;
  maxRetries?: number;
  /** Warn (sticky UI widget) when the reviewer-latency EMA exceeds this many
   *  milliseconds. Default 8000. */
  latencyWarnEmaMs?: number;
}

/** Configurable prompt keybindings (key identifiers as understood by
 * pi-tui's `matchesKey`, e.g. "n", "shift+n", "escape", "ctrl+c").
 * Uppercase letters cannot be expressed as a bare capital (pi-tui lowercases
 * single-char ids); use the shifted form, e.g. "shift+n" for N. */
export interface PromptKeybindings {
  /** Key id for deny-and-continue, or undefined to disable the shortcut. */
  denyContinue?: string;
  /** Key id for deny-and-abort. Always set (defaults to "escape"). */
  denyAbort: string;
}

/** Minimal structural view of a session-journal entry (custom entries carry
 * customType/data). Lets core/ read journals without importing harness types. */
export interface JournalEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Structural seam for reading a session journal without harness imports. */
export interface SessionJournalSource {
  sessionManager: { getBranch(): readonly JournalEntryLike[] };
}

/** Structural seam for appending session-journal entries without harness imports. */
export interface AppendEntrySink {
  appendEntry(customType: string, data?: unknown): void;
}

/** Structural seam for reading the full session journal (not just the branch). */
export interface SessionEntriesSource {
  sessionManager: { getEntries(): readonly JournalEntryLike[] };
}