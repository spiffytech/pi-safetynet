import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ProfileName } from "./types.ts";
import { toDisplayPath } from "./project.ts";

export type PermissionChoice = "once" | "timed" | "turn" | "edit" | "deny";

export interface PermissionPromptOptions {
  permission: "bash" | "edit" | "read";
  target: string;
  unapproved?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  reason?: string | undefined;
  /** Minutes for timed approval (default 15). */
  timedApprovalMinutes?: number;
  /** True when re-prompting after rules were added but still insufficient. */
  reprompt?: boolean;
}

/**
 * Run an async operation with tool output forced to expanded state.
 * Useful when a dialog is shown that swallows keyboard shortcuts,
 * preventing the user from manually expanding tool output to assess
 * what the agent is doing while awaiting approval.
 */
async function withToolsExpanded<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
  const wasExpanded = ctx.ui.getToolsExpanded();
  ctx.ui.setToolsExpanded(true);
  try {
    return await fn();
  } finally {
    ctx.ui.setToolsExpanded(wasExpanded);
  }
}

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  opts: PermissionPromptOptions,
): Promise<PermissionChoice> {
  if (!ctx.hasUI) return "deny";

  const isFile = opts.permission === "read" || opts.permission === "edit";

  // For bash: skip printing the command — Pi's own tool rendering already shows it.
  // Just show the permission type; long commands caused viewport overflow / flicker.
  let header = isFile
    ? `⚠️ ${opts.permission}: ${toDisplayPath(opts.target)}`
    : `⚠️ ${opts.permission}`;

  // Unapproved subcommands also omitted for bash (Pi shows the command already).
  // File redirect targets are still shown since they aren't displayed elsewhere.
  // TODO: restore command display with viewport-aware truncation later.

  if (opts.redirectTargets && opts.redirectTargets.length > 0) {
    header += "\n\n   Contains redirect targets needing approval:";
    for (const rt of opts.redirectTargets) {
      header += `\n   • ${rt.permission}: ${toDisplayPath(rt.path)}`;
    }
  }

  if (opts.reason) {
    header += `\n\n   Reason: ${opts.reason}`;
  }

  if (opts.reprompt) {
    header += "\n\n   ℹ️ Rules were added but still insufficient — additional approval needed.";
  }

  const minutes = opts.timedApprovalMinutes ?? 15;
  const choices = [
    "Allow once",
    "Edit rules...",
    `Approve for ${minutes} min`,
    "Approve for turn",
    "Deny",
  ];

  const choice = await withToolsExpanded(ctx, () => ctx.ui.select(header, choices));

  switch (choice) {
    case "Allow once":
      return "once";
    case `Approve for ${minutes} min`:
      return "timed";
    case "Approve for turn":
      return "turn";
    case "Edit rules...":
      return "edit";
    default:
      return "deny";
  }
}

export async function showRulesEditor(
  ctx: ExtensionContext,
  unapproved: string[],
  isFilePaths: boolean = false,
): Promise<{ patterns: string[]; persist: "session" | "persisted" } | null> {
  if (!ctx.hasUI) return null;

  const displayItems = isFilePaths
    ? unapproved.map((p) => toDisplayPath(p))
    : unapproved;
  const defaultText = displayItems.join("\n");
  const result = await withToolsExpanded(ctx, () =>
    ctx.ui.editor(
      "Edit rules (one per line, use * as wildcard):",
      defaultText,
    )
  );

  if (result === undefined || result === null || result.trim().length === 0) return null;

  const patterns = result
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (patterns.length === 0) return null;

  const persist = await withToolsExpanded(ctx, () =>
    ctx.ui.select(
      "Save rules to:",
      ["This session only", "Project"],
    )
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
  return withToolsExpanded(ctx, () => ctx.ui.confirm("Profile Escalation", msg));
}

export function notifyProfileSwitch(
  ctx: ExtensionContext,
  from: ProfileName,
  to: ProfileName,
): void {
  ctx.ui.notify(`Switched from ${from} to ${to} mode`, "info");
}
