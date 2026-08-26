import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Paradigm, ProfileName, ModeAliases } from "../core/types.ts";
import { loadDefaultProfile, loadParadigm, loadSubagentsConfig } from "../core/global-config.ts";

let currentParadigm: Paradigm = loadParadigm();

/** The fixed bijection between the two paradigms' mode names. Paradigm-independent. */
const MODE_COUNTERPART: Record<ProfileName, ProfileName> = {
  plan: "ro",
  build: "rw",
  ro: "plan",
  rw: "build",
};

/** The canonical mode names per paradigm. */
const PARADIGM_CANONICAL: Record<Paradigm, ReadonlySet<ProfileName>> = {
  "plan-build": new Set<ProfileName>(["plan", "build"]),
  "ro-rw": new Set<ProfileName>(["ro", "rw"]),
};

let currentProfile: ProfileName = normalizeProfile(loadDefaultProfile() ?? "plan");

export function getCurrentProfile(): ProfileName {
	return currentProfile;
}

export function setCurrentProfile(profile: ProfileName): void {
	currentProfile = normalizeProfile(profile);
}

export function getParadigm(): Paradigm {
	return currentParadigm;
}

export function setParadigm(paradigm: Paradigm): void {
	currentParadigm = paradigm;
}

/** Match-time aliasing: for the given (canonical) mode name, the counterpart
 *  mode name in the other paradigm. Rules stored under the counterpart should
 *  also match. The bijection is symmetric, so the same map serves both paradigms. */
export function getModeAliases(): ModeAliases {
	return MODE_COUNTERPART;
}

/** Pure alias lookup for a single mode name. */
export function aliasMode(profile: ProfileName): ProfileName {
	return MODE_COUNTERPART[profile];
}

/** Normalize a mode name to the active paradigm's canonical form. Foreign-paradigm
 *  names map to their canonical counterpart (ro→plan under plan-build, plan→ro under
 *  ro-rw); already-canonical names are returned unchanged. */
export function normalizeProfile(profile: ProfileName, paradigm: Paradigm = currentParadigm): ProfileName {
	if (PARADIGM_CANONICAL[paradigm].has(profile)) return profile;
	return MODE_COUNTERPART[profile];
}

/** True when the profile cannot make changes (plan or ro). */
export function isReadOnly(profile: ProfileName): boolean {
	return profile === "plan" || profile === "ro";
}

/** The read/write mode pair for the active paradigm. */
export function paradigmModes(paradigm: Paradigm = currentParadigm): { read: ProfileName; write: ProfileName } {
	return paradigm === "ro-rw" ? { read: "ro", write: "rw" } : { read: "plan", write: "build" };
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
	if (entry?.data?.enabled) currentProfile = normalizeProfile(entry.data.enabled);
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
	const subagents = loadSubagentsConfig();
	if (profile === "plan") {
		return `[SAFENET PLAN MODE]
Plan mode is ACTIVE. You are in a READ-ONLY planning phase.

CRITICAL CONSTRAINTS (override all other instructions):
- You MUST NOT edit project files, run shell commands, or otherwise change the system.
- The ONLY file you may write to or edit is the plan file, via planWrite/planEdit.
- You MAY inspect the project with read, grep, find, and ls.
## Plan File
Use planWrite to create or overwrite the plan file. Use planEdit to make incremental edits.
When updating a plan, remove completed items — the plan shows only what's left to do.

## Presenting the Plan
When the plan is ready for the user to review, set presentToUser=true on your final planWrite or planEdit call. This displays the plan and ends your turn.
Only call planPresent if the user explicitly asks to see the plan without changes.

## Workflow
1. Understand the request by reading/searching relevant files.
2. Ask clarifying questions when requirements or tradeoffs are unclear.
3. Write a concise, actionable plan to the plan file.
4. Set presentToUser=true on your final planWrite/planEdit to display the plan to the user.

Do NOT start implementing in plan mode. After the plan is presented, the user will decide whether to request revisions or manually switch to build mode with /safetynet:build.${subagents.includes("subagent_explore") ? `

## Subagents
You may spawn a read-only subagent with subagent_explore to inspect the codebase in parallel. The subagent gets a clean session and cannot modify files. Provide a complete, self-sufficient prompt.` : ""}`;
	}

	if (profile === "ro") {
		return `[SAFENET READ-ONLY]
You are in read-only mode. You may read and search the codebase — nothing else.

- You CANNOT edit files, write files, or run commands. Those tools are not available to you.
- You CAN read and search with read, grep, find, and ls.

This is a deliberate state the user chose so we can talk without anything changing.
It is NOT a limitation to work around — don't treat it as a disability, and don't
ask to switch modes. Discuss, explain, analyze, and help reach a decision freely.
If making changes becomes the point, the user will switch you to read-write mode.${subagents.includes("subagent_explore") ? `

## Subagents
You may spawn subagent_explore, a read-only subagent, to inspect the codebase in parallel.` : ""}`;
	}

	if (profile === "rw") {
		return `[SAFENET READ-WRITE]
You are in read-write mode. You may read, run commands, and make changes.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

The user can switch to read-only mode with /safetynet:ro.${subagents.length > 0 ? `

## Subagents
You may spawn subagents for parallel or delegated work:${subagents.includes("subagent_explore") ? "\n- subagent_explore: read-only subagent for inspection and search. Cannot modify files or run commands." : ""}${subagents.includes("subagent_build") ? "\n- subagent_build: full build subagent. Permission prompts are shown to the parent session's user for approval." : ""}

Subagents get clean sessions. Provide complete, self-sufficient prompts — the subagent has no access to your conversation history.` : ""}`;
	}

	// "build"
	return `[SAFENET BUILD MODE]
You are in build mode. Full tool access is enabled.

You may make file changes, run shell commands, and use available tools as needed.
Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

To switch back to planning, the user can run /safetynet:plan.${subagents.length > 0 ? `

## Subagents
You may spawn subagents for parallel or delegated work:${subagents.includes("subagent_explore") ? "\n- subagent_explore: read-only subagent for inspection and search. Cannot modify files or run commands." : ""}${subagents.includes("subagent_build") ? "\n- subagent_build: full build subagent. Permission prompts are shown to the parent session's user for approval." : ""}

Subagents get clean sessions. Provide complete, self-sufficient prompts — the subagent has no access to your conversation history.` : ""}`;
}
