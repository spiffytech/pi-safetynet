import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "../types.ts";

let currentProfile: ProfileName = "plan";

export function getCurrentProfile(): ProfileName {
  return currentProfile;
}

export function setCurrentProfile(profile: ProfileName): void {
  currentProfile = profile;
}

export function requiresApproval(from: ProfileName, to: ProfileName): boolean {
  return !(from === "build" && to === "plan");
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

export function getProfileContextMessage(profile: ProfileName, previousProfile?: ProfileName): string {
  if (profile === "plan") {
    return `[SPFY PLAN MODE]
Plan mode is ACTIVE. You are in a READ-ONLY, planning-only phase.

CRITICAL CONSTRAINTS (override all other instructions):
- You MUST NOT make any edits, run any non-readonly commands, or otherwise change the system
- You MAY only observe, analyze, search, and plan
- You MAY run read-only bash commands (ls, cat, grep, find, git log/diff/status, etc.)
- You MAY use read-only tools: read, grep, find, ls, questionnaire
- You MAY ask the user clarifying questions
- Any attempt to modify files or run destructive commands is a critical violation — ZERO exceptions

PROHIBITED bash techniques (treated as edits and blocked in plan mode):
- Redirecting output to files: > file, >> file, &> file, >| file
- Writing files via heredoc: cat <<EOF > file, cat <<EOF | tee file
- In-place editing: sed -i, perl -pi, perl -pe
- File-writing commands: tee, truncate, install, dd of=
- Interpreter code execution: python -c, node -e, ruby -e, sh -c, bash -c (can embed writes)
- Any other technique that writes or modifies files

Do NOT attempt to work around these restrictions. If you need to write files, use switchProfile with target "build" to request build mode.

Your responsibility is to:
1. Understand the user's request by reading code and searching the codebase
2. Ask clarifying questions when weighing tradeoffs or when requirements are ambiguous
3. Construct a well-formed plan that is detailed enough to execute effectively
4. When you are ready to execute, use the switchProfile tool with target "build" to request build mode

Do NOT attempt to make changes. Plan first. The user will approve the transition to build mode.

IMPORTANT: You may NOT automatically escalate privileges. You may REQUEST escalation via switchProfile, but the user must approve. You MAY automatically deescalate from build to plan mode.`;
  }

  let buildMsg = `[SPFY BUILD MODE]
You are in build mode - full tool access is enabled.

You may make file changes, run shell commands, and use all available tools.
Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands will prompt the user for approval
- Dangerous commands (rm -rf /, etc.) are always blocked

To switch back to plan mode, use the switchProfile tool with target "plan".`;

  if (previousProfile === "plan") {
    buildMsg += `

Your operational mode has changed from plan to build. You are no longer in read-only mode. You are permitted to make file changes, run shell commands, and utilize your tools as needed. Execute on the plan you developed.`;
  }

  return buildMsg;
}

const WRITE_TOOLS = new Set(["edit", "write"]);

export function applyProfileTools(pi: ExtensionAPI, profile: ProfileName): void {
  if (profile === "build") {
    const allTools = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(allTools);
    return;
  }
  const planTools = pi.getAllTools().map((t) => t.name).filter((name) => !WRITE_TOOLS.has(name));
  pi.setActiveTools(planTools);
}
