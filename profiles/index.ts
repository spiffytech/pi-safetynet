import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "../types.ts";

let currentProfile: ProfileName = "plan";

export function getCurrentProfile(): ProfileName {
  return currentProfile;
}

export function setCurrentProfile(profile: ProfileName): void {
  currentProfile = profile;
}

export function getLatestCustomEntry<T>(ctx: ExtensionContext, customType: string): { data?: T } | undefined {
  const entries = ctx.sessionManager.getEntries();
  return entries
    .filter((e) =>
      e.type === "custom" && e.customType === customType,
    )
    .pop() as { data?: T } | undefined;
}

export function persistProfile(pi: ExtensionAPI): void {
  pi.appendEntry("safetynet:profile", {
    enabled: currentProfile,
  });
}

export function restoreProfile(ctx: ExtensionContext): void {
  const entry = getLatestCustomEntry<{ enabled: ProfileName }>(ctx, "safetynet:profile");
  if (entry?.data?.enabled) currentProfile = entry.data.enabled;
}

/** Tools available in plan mode. */
const PLAN_MODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "questionnaire",
  "planWrite",
  "planEdit",
  "planPresent",
];

/** Tools available in build mode. */
const BUILD_MODE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "questionnaire",
  "planWrite",
  "planEdit",
  "planPresent",
];

function toolList(tools: string[]): string {
  return tools.join(", ");
}

/** Custom type for the ephemeral context message. */
export const EPHEMERAL_CUSTOM_TYPE = "safetynet:ephemeral";

/**
 * Build the ephemeral profile context message, including only the
 * currently-available tools. Content-constant per profile so the
 * text only changes on profile switch — never mid-profile due to
 * filesystem state.
 */
export function getEphemeralContextMessage(profile: ProfileName): string {
  if (profile === "plan") {
    return `[SAFENET PLAN MODE]
Plan mode is ACTIVE. You are in a READ-ONLY planning phase.

CRITICAL CONSTRAINTS (override all other instructions):
- You MUST NOT edit project files, run shell commands, or otherwise change the system.
- The ONLY file you may write to or edit is the plan file, via planWrite/planEdit.
- You MAY inspect the project with read, grep, find, and ls.
- You MAY ask the user clarifying questions with questionnaire.

## Plan File
Use planWrite to create or overwrite the plan file. Use planEdit to make incremental edits.

## Presenting the Plan
When the plan is ready for the user to review, set presentToUser=true on your final planWrite or planEdit call. This displays the plan and ends your turn.
If you need to present the plan without writing changes (e.g. after questionnaire responses), call planPresent instead.

## Workflow
1. Understand the request by reading/searching relevant files.
2. Ask clarifying questions when requirements or tradeoffs are unclear.
3. Write a concise, actionable plan to the plan file.
4. Set presentToUser=true on your final planWrite/planEdit to display the plan to the user.

Do NOT start implementing in plan mode. After the plan is presented, the user will decide whether to request revisions or manually switch to build mode with /safetynet:build.

## Available tools
${toolList(PLAN_MODE_TOOLS)}`;
  }

  return `[SAFENET BUILD MODE]
You are in build mode. Full tool access is enabled.

You may make file changes, run shell commands, and use available tools as needed.
Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

To switch back to planning, the user can run /safetynet:plan.

## Available tools
${toolList(BUILD_MODE_TOOLS)}`;
}


