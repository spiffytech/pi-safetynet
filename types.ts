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

export const SwitchProfileParams = Type.Object({
  target: Type.Union([Type.Literal("plan"), Type.Literal("build")], {
    description: "Target profile: 'plan' or 'build'",
  }),
  reason: Type.Optional(
    Type.String({ description: "Reason for switching profiles" }),
  ),
});
