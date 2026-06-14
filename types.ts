export type ProfileName = "plan" | "build";
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

/** Expiry policy for a temporary approval rule. */
export type TempExpiry = { type: "turn" };


/** A rule with a temporary lifespan. */
export interface TempRule {
  rule: Rule;
  expiry: TempExpiry;
}
