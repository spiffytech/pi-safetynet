import type { Paradigm, ProfileName, ModeAliases, AppendEntrySink, SessionEntriesSource } from "./types.ts";
import { loadDefaultProfile, loadParadigm } from "./global-config.ts";

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

/** Modes an accepted rule should cover: the write mode alone when accepting in
 *  a write session, both read and write when accepting in a read-only session.
 *  Mirrors the explicit-approval `allowModes` computation. A rule learned under
 *  read-only enforcement is safe in a write session; the reverse is not — it
 *  would auto-allow, without review, a write the read-only reviewer would have
 *  denied — so write-mode rules stay write-only. */
export function acceptanceModes(): ProfileName[] {
	const { read, write } = paradigmModes();
	return getCurrentProfile() === write ? [write] : [read, write];
}

export function getLatestCustomEntry<T>(journal: SessionEntriesSource, customType: string): { data?: T } | undefined {
	const entries = journal.sessionManager.getEntries();
	return entries
		.filter((e) =>
			e.type === "custom" && e.customType === customType,
		)
		.pop() as { data?: T } | undefined;
}

export function persistProfile(pi: AppendEntrySink): void {
	pi.appendEntry("safetynet:profile", {
		enabled: currentProfile,
	});
}

export function restoreProfile(ctx: SessionEntriesSource): void {
	const entry = getLatestCustomEntry<{ enabled: ProfileName }>(ctx, "safetynet:profile");
	if (entry?.data?.enabled) currentProfile = normalizeProfile(entry.data.enabled);
}

/** Custom type for durable mode-reminder messages (persisted, shown in transcript). */
export const MODE_REMINDER_CUSTOM_TYPE = "safetynet:mode-reminder";

/** Mode-specific system-prompt stanza appended at agent start: read-write. */
export const READ_WRITE_SYSTEM_PROMPT_BLOCK = `[SAFETYNET READ-WRITE]
You are in read-write mode. You may read, run commands, and make changes.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

The user can switch to read-only mode with /safetynet:ro.

## Subagents
You may spawn subagents for parallel or delegated work:
- subagent_explore: read-only subagent for inspection and search. Cannot modify files or run commands.
- subagent_build: full build subagent. Permission prompts are shown to the parent session's user for approval.

Subagents get clean sessions. Provide complete, self-sufficient prompts — the subagent has no access to your conversation history.`;

/** Mode-specific system-prompt stanza appended at agent start: read-only.
 *  Frames the mode as a research-and-discussion phase — the user is not ready
 *  for changes yet — and tells the model to honor the spirit of the mode,
 *  not just its letter: no workarounds through bash tricks or build
 *  subagents, propose instead. */
export const READ_ONLY_SYSTEM_PROMPT_BLOCK = `[SAFETYNET READ-ONLY]
You are in read-only mode. This is a research-and-discussion phase, not a work phase: the user is not ready for changes yet and switched here to inspect, analyze, and plan. Treat that as the point of the mode, not a hurdle to work around — do not try to get the underlying task done "anyway."

Honor the spirit of read-only mode — do not look for ways around it:
- Do not attempt edits or writes, including through bash (redirects into files, sed -i, tee, heredocs, interpreter one-liners) or by delegating implementation to a subagent.
- Read, search, analyze, and propose. If a change is needed, describe exactly what you would do and let the user switch to read-write mode with /safetynet:rw.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

The user can switch to read-write mode with /safetynet:rw.

## Subagents
You may spawn subagents for parallel or delegated work:
- subagent_explore: read-only subagent for inspection and search. Cannot modify files or run commands.
- subagent_build: full build subagent. Permission prompts are shown to the parent session's user for approval.

Do not spawn subagent_build to implement changes while in read-only mode — propose the changes instead and let the user switch to read-write mode.

Subagents get clean sessions. Provide complete, self-sufficient prompts — the subagent has no access to your conversation history.`;

/** Pick the system-prompt stanza for the active mode. */
export function getModeSystemPrompt(profile: ProfileName): string {
	return isReadOnly(profile) ? READ_ONLY_SYSTEM_PROMPT_BLOCK : READ_WRITE_SYSTEM_PROMPT_BLOCK;
}

/** Durable user message appended on mode switch (exactly one per switch). */
export function getModeSwitchMessage(profile: ProfileName): string {
	if (isReadOnly(profile)) {
		return `<system-reminder>
The user has switched you to read-only mode: research and discussion only, not work — the user is not ready for changes yet. You may only inspect and read; do not modify files or run state-changing commands, and do not try to get the task done anyway.
</system-reminder>`;
	}
	return `<system-reminder>
The user has switched you to read-write mode. You may now run commands and modify files.
</system-reminder>`;
}

/** Durable message appended at session start and after compaction. */
export function getSessionModeMessage(profile: ProfileName): string {
	if (isReadOnly(profile)) {
		return `<system-reminder>
This session is in read-only mode: research and discussion only — the user is not ready for changes yet.
</system-reminder>`;
	}
	return `<system-reminder>
This session is in read-write mode.
</system-reminder>`;
}
