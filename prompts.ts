import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "./types.ts";

export interface PermissionPromptOptions {
  permission: "bash" | "edit" | "read";
  target: string;
  unapproved?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  reason?: string | undefined;
}

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  opts: PermissionPromptOptions,
): Promise<"once" | "edit" | "deny"> {
  if (!ctx.hasUI) return "deny";

  let header = `⚠️ ${opts.permission}: ${opts.target}`;

  if (opts.unapproved && opts.unapproved.length > 0) {
    header += "\n\n   Contains unapproved commands:";
    for (const cmd of opts.unapproved) {
      header += `\n   • ${cmd}`;
    }
  }

  if (opts.redirectTargets && opts.redirectTargets.length > 0) {
    header += "\n\n   Contains redirect targets needing approval:";
    for (const rt of opts.redirectTargets) {
      header += `\n   • ${rt.permission}: ${rt.path}`;
    }
  }

  if (opts.reason) {
    header += `\n\n   Reason: ${opts.reason}`;
  }

  const choice = await ctx.ui.select(header, [
    "Allow once",
    "Edit rules...",
    "Deny",
  ]);

  switch (choice) {
    case "Allow once":
      return "once";
    case "Edit rules...":
      return "edit";
    default:
      return "deny";
  }
}

export async function showRulesEditor(
  ctx: ExtensionContext,
  unapproved: string[],
): Promise<{ patterns: string[]; persist: "session" | "persisted" } | null> {
  if (!ctx.hasUI) return null;

  const defaultText = unapproved.join("\n");
  const result = await ctx.ui.editor(
    "Edit rules (one per line, use * as wildcard):",
    defaultText,
  );

  if (result === undefined || result === null || result.trim().length === 0) return null;

  const patterns = result
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (patterns.length === 0) return null;

  const persist = await ctx.ui.select(
    "Save rules to:",
    ["This session only", "Project"],
  );

  if (persist === undefined) return null;

  return {
    patterns,
    persist: persist.startsWith("Project") ? "persisted" : "session",
  };
}

export async function promptProfileEscalation(
  ctx: ExtensionContext,
  reason?: string,
): Promise<boolean> {
  if (!ctx.hasUI) return false;

  const msg = reason
    ? `Switch to build mode?\n\nReason: ${reason}`
    : "Switch to build mode?";
  return ctx.ui.confirm("Profile Escalation", msg);
}

export function notifyProfileSwitch(
  ctx: ExtensionContext,
  from: ProfileName,
  to: ProfileName,
): void {
  ctx.ui.notify(`Switched from ${from} to ${to} mode`, "info");
}

