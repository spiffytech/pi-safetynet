import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "../types.ts";

let currentProfile: ProfileName = "plan";

export function getCurrentProfile(): ProfileName {
  return currentProfile;
}

export function setCurrentProfile(profile: ProfileName): void {
  currentProfile = profile;
}

interface ProfileConfig {
  trustedProfileTransitions: ProfileName[];
}

const PROFILES: Record<ProfileName, ProfileConfig> = {
  plan: { trustedProfileTransitions: [] },
  build: { trustedProfileTransitions: ["plan"] },
};

export function getProfileConfig(profile: ProfileName): ProfileConfig {
  return PROFILES[profile];
}

export function requiresApproval(from: ProfileName, to: ProfileName): boolean {
  return !PROFILES[from].trustedProfileTransitions.includes(to);
}

export function persistProfile(pi: ExtensionAPI): void {
  pi.appendEntry("spfy:profile", {
    enabled: currentProfile,
  });
}

export function restoreProfile(ctx: ExtensionContext): void {
  const entries = ctx.sessionManager.getEntries();
  const profileEntry = entries
    .filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "spfy:profile",
    )
    .pop() as { data?: { enabled?: ProfileName } } | undefined;

  if (profileEntry?.data?.enabled) {
    currentProfile = profileEntry.data.enabled;
  }
}

export function getProfileContextMessage(profile: ProfileName): string {
  if (profile === "plan") {
    return `[SPFY PROFILE: plan]
You are in plan mode - a cautious mode with user approval required.

Behavior:
- Allowlisted commands (cat, ls, grep, git status/log/diff, etc.) run silently
- All other actions require user approval (prompted)
- Hazardous file access (.env, .ssh, credentials) is hard-blocked
- Catastrophic commands (rm -rf /, etc.) are hard-blocked

To switch to build mode, use the switchProfile tool with target "build".`;
  }

  return `[SPFY PROFILE: build]
You are in build mode - full access with progressive trust.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands will prompt the user for approval
- Dangerous commands (rm -rf /, etc.) are always blocked

To switch to plan mode, use the switchProfile tool with target "plan".`;
}

export function getToolsForProfile(profile: ProfileName): string[] {
  return ["read", "edit", "write", "bash", "questionnaire", "switchProfile"];
}

export function applyProfileTools(pi: ExtensionAPI, profile: ProfileName): void {
  pi.setActiveTools(getToolsForProfile(profile));
}
