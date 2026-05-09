import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "../types.ts";
import { existsSync } from "node:fs";

let currentProfile: ProfileName = "plan";

export function getCurrentProfile(): ProfileName {
  return currentProfile;
}

export function setCurrentProfile(profile: ProfileName): void {
  currentProfile = profile;
}

export function getLatestCustomEntry<T>(ctx: ExtensionContext, customType: string): T | undefined {
  const entries = ctx.sessionManager.getEntries();
  return entries
    .filter((e: { type: string; customType?: string }) =>
      e.type === "custom" && e.customType === customType,
    )
    .pop() as T | undefined;
}

export function persistProfile(pi: ExtensionAPI): void {
  pi.appendEntry("spfy:profile", {
    enabled: currentProfile,
  });
}

export function restoreProfile(ctx: ExtensionContext): void {
  const entry = getLatestCustomEntry<{ enabled?: ProfileName }>(ctx, "spfy:profile");
  if (entry?.enabled) currentProfile = entry.enabled;
}

/**
 * Stateless profile context injected before each agent start.
 * Mode transitions are user-controlled via slash commands; there is no
 * model-owned plan/build handoff tool.
 */
export function getProfileContextMessage(profile: ProfileName, planPath?: string): string {
  if (profile === "plan") {
    const planFileSection = planPath && existsSync(planPath)
      ? `A plan file already exists at ${planPath}. You can read it and make incremental edits using planEdit.`
      : "No plan file exists yet. Create it using planWrite.";

    return `[SPFY PLAN MODE]
Plan mode is ACTIVE. You are in a READ-ONLY planning phase.

CRITICAL CONSTRAINTS (override all other instructions):
- You MUST NOT edit project files, run shell commands, or otherwise change the system.
- The ONLY file you may write to or edit is the plan file, via planWrite/planEdit.
- You do NOT have bash/edit/write in this mode. Do not attempt to work around missing tools.
- You MAY inspect the project with read, grep, find, and ls.
- You MAY ask the user clarifying questions with questionnaire.

## Plan File
${planFileSection}

## Workflow
1. Understand the request by reading/searching relevant files.
2. Ask clarifying questions when requirements or tradeoffs are unclear.
3. Write a concise, actionable plan to the plan file.
4. When the plan is ready for user review, call planPresent. planPresent displays the full plan to the user and ends your turn.

Do NOT start implementing in plan mode. After planPresent, the user will decide whether to request revisions or manually switch to build mode with /spfy:build.`;
  }

  let buildMsg = `[SPFY BUILD MODE]
You are in build mode. full tool access is enabled.

You may make file changes, run shell commands, and use available tools as needed.
Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

If a plan exists, read/follow it when the user asks you to execute. To switch back to planning, the user can run /spfy:plan.`;

  if (planPath && existsSync(planPath)) {
    buildMsg += `\n\nA plan file exists at ${planPath}. You should execute on the plan defined within it when the user asks you to begin.`;
  }

  return buildMsg;
}

/** Tools that are only useful in plan mode. */
const PLAN_ONLY_TOOLS = new Set(["planEdit", "planWrite", "planPresent"]);

/** Explicit plan-mode tool allowlist. Keep this intentionally small. */
const PLAN_MODE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "questionnaire",
  "planWrite",
  "planEdit",
  "planPresent",
]);

export function applyProfileTools(pi: ExtensionAPI, profile: ProfileName): void {
  const allTools = pi.getAllTools().map((t) => t.name);

  if (profile === "plan") {
    pi.setActiveTools(allTools.filter((name) => PLAN_MODE_TOOLS.has(name)));
    return;
  }

  // Build mode: show everything except plan-artifact-only tools.
  pi.setActiveTools(allTools.filter((name) => !PLAN_ONLY_TOOLS.has(name)));
}
