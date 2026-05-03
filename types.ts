import { Type } from "@sinclair/typebox";

export type ProfileName = "plan" | "build";
export type PermissionAction = "allow" | "deny" | "ask";
export type PermissionName = "bash" | "edit" | "read" | "*";

export interface Rule {
  permission: PermissionName;
  pattern: string;
  action: PermissionAction;
  modes: ProfileName[];
}

export type Ruleset = Rule[];

/** Expiry policy for a temporary approval rule. */
export type TempExpiry =
  | { type: "time"; expiresAt: number }   // Unix timestamp ms
  | { type: "turn" };                      // Expires on next agent_end

/** A rule with a temporary lifespan. */
export interface TempRule {
  rule: Rule;
  expiry: TempExpiry;
}

export const SwitchProfileParams = Type.Object({
  target: Type.Union([Type.Literal("plan"), Type.Literal("build")], {
    description: "Target profile: 'plan' or 'build'",
  }),
  reason: Type.Optional(
    Type.String({ description: "Reason for switching profiles" }),
  ),
});
