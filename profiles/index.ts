import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Paradigm, ProfileName, ModeAliases } from "../types.ts";
import { loadDefaultProfile, loadParadigm } from "../global-config.ts";

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

/** Custom type for durable mode-reminder messages (persisted, shown in transcript). */
export const MODE_REMINDER_CUSTOM_TYPE = "safetynet:mode-reminder";

/**
 * Static block appended to the system prompt exactly once (byte-identical
 * across turns so the KV-cache prefix stays stable). Mode-independent: the
 * active mode is conveyed by durable reminder messages instead.
 */
export const STATIC_SYSTEM_PROMPT_BLOCK = `## Permissions

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

The user can toggle between read-only and read-write mode at any time.

## Subagents

You may spawn subagents for parallel or delegated work:
- subagent_explore: read-only subagent for inspection and search. Cannot modify files or run commands.
- subagent_build: full build subagent. Permission prompts are shown to the parent session's user for approval.

Subagents get clean sessions. Provide complete, self-sufficient prompts — the subagent has no access to your conversation history.`;

/** Durable user message appended on mode switch (exactly one per switch). */
export function getModeSwitchMessage(profile: ProfileName): string {
	if (isReadOnly(profile)) {
		return `<system-reminder>
The user has switched you to read-only mode. You may now only inspect and read. Do not modify files or run state-changing commands.
</system-reminder>`;
	}
	return `<system-reminder>
The user has switched you to read-write mode. You may now run commands and modify files.
</system-reminder>`;
}

/** Durable message appended at session start and after compaction. */
export function getSessionModeMessage(profile: ProfileName): string {
	const mode = isReadOnly(profile) ? "read-only" : "read-write";
	return `<system-reminder>
This session is in ${mode} mode.
</system-reminder>`;
}
