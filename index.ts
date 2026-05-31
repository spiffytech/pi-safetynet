import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@mariozechner/pi-tui";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createEditTool,
  createWriteTool,
  getMarkdownTheme,
  isBashToolResult,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule, Ruleset, TempRule, ProfileName, PermissionAction } from "./types.ts";
import questionnaire from "./questionnaire.ts";
import { runSubagent } from "./subagent.ts";
import {
  getBaselineRules,
  PermissionStorage,
  reconstructSessionRules,
} from "./permissions/index.ts";
import {
  getCurrentProfile,
  setCurrentProfile,
  getEphemeralContextMessage,
  EPHEMERAL_CUSTOM_TYPE,
  persistProfile,
  restoreProfile,
} from "./profiles/index.ts";
import {
  isPlanOnErrorEnabled,
  setPlanOnError,
  togglePlanOnError,
  restorePlanOnError,
  getPlanOnErrorInstruction,
} from "./profiles/plan-on-error.ts";
import {
  showPermissionPrompt,
} from "./prompts.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./check.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./project.ts";

let storage: PermissionStorage;

/** Current model display string (provider/model-id), updated via model_select events. */
let currentModelDisplay: string = "";

/** Extension directory — resolved at module load via import.meta.url */
const extDir = dirname(fileURLToPath(import.meta.url));

/** Directory for plan files */
const plansDir = join(extDir, "plans");

/** Get the plan file path for a given session ID */
function getPlanFilePath(sessionId: string): string {
  return join(plansDir, `${sessionId}.md`);
}

/** Default number of minutes for timed approval. */
const DEFAULT_TIMED_APPROVAL_MINUTES = 15;

const VALID_PERMISSIONS = new Set(["bash", "edit", "read", "*"]);

/**
 * Parse a comma-separated `--allow` flag value into rules.
 * Format: "permission: pattern, permission: pattern"
 * Example: "edit: src/**, bash: npm *"
 */
export function parseAllowFlag(raw: string): Ruleset {
  return raw.split(",").flatMap((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return [];
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) return [];
    const permission = trimmed.slice(0, colonIdx).trim();
    const pattern = trimmed.slice(colonIdx + 1).trim();
    if (!VALID_PERMISSIONS.has(permission) || !pattern) return [];
    return [{
      permission: permission as Rule["permission"],
      pattern,
      action: "allow" as const,
      modes: ["build" as const],
    }];
  });
}

function getTimedApprovalMinutes(): number {
  const val = pi.getFlag("timed-approval-minutes");
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof val === "number" && val > 0) return val;
  return DEFAULT_TIMED_APPROVAL_MINUTES;
}

/**
 * Build a TempRule entry from the current permission check context.
 */
function makeTempRules(
  opts: {
    permission: "bash" | "read" | "edit";
    patterns: string[];
    profile: ProfileName;
    expiryType: "time" | "turn";
    minutes?: number;
  },
): TempRule[] {
  const newModes: ProfileName[] = opts.profile === "plan" ? ["plan", "build"] : ["build"];
  return opts.patterns.map((p) => ({
    rule: {
      permission: opts.permission as Rule["permission"],
      pattern: p,
      action: "allow" as const,
      modes: newModes,
    },
    expiry: opts.expiryType === "time"
      ? { type: "time" as const, expiresAt: Date.now() + (opts.minutes ?? DEFAULT_TIMED_APPROVAL_MINUTES) * 60_000 }
      : { type: "turn" as const },
  }));
}

/** Check headless-mode deny behavior. Pure function for testability. */
export function headlessDeny(
  hasUI: boolean,
  action: PermissionAction,
  permission: "bash" | "read" | "edit",
): { block: boolean; reason: string } | undefined {
  if (hasUI || action !== "ask") return undefined;
  const label = permission[0]!.toUpperCase() + permission.slice(1);
  return { block: true, reason: `${label} requires approval (headless mode)` };
}

async function resolvePermission(
  ctx: ExtensionContext,
  opts: {
    permission: "bash" | "read" | "edit";
    target: string;
    check: PermissionCheck;
    recheck: () => PermissionCheck;
    cwd: string;
  },
): Promise<{ block: boolean; reason: string } | undefined> {
  const { action } = opts.check;

  if (action === "allow") return undefined;

  if (action === "deny") {
    ctx.abort();
    const label = opts.permission[0]!.toUpperCase() + opts.permission.slice(1);
    return { block: true, reason: `${label} denied: ${opts.check.reason ?? "no matching allow rule"}` };
  }

  // Headless: no TUI available to show permission prompt, deny by default
  const denied = headlessDeny(ctx.hasUI, action, opts.permission);
  if (denied) {
    if (!ctx.hasUI) console.error(`safetynet: ${denied.reason}`);
    ctx.abort();
    return denied;
  }

  const profile = getCurrentProfile();
  const timedMinutes = getTimedApprovalMinutes();
  const isFile = opts.permission === "read" || opts.permission === "edit";

  let reprompt = false;
  while (true) {
    const promptOpts: Parameters<typeof showPermissionPrompt>[1] = {
      permission: opts.permission,
      target: opts.target,
      timedApprovalMinutes: timedMinutes,
      reprompt,
    };
    if (opts.check.unapproved && opts.check.unapproved.length > 0) promptOpts.unapproved = opts.check.unapproved;
    if (opts.check.redirectTargets?.length) promptOpts.redirectTargets = opts.check.redirectTargets;
    if (opts.check.reason) promptOpts.reason = opts.check.reason;

    const result = await showPermissionPrompt(ctx, promptOpts);

    // User pressed escape / denied
    if (result === null) {
      ctx.abort();
      return { block: true, reason: `User denied ${opts.permission}` };
    }

    const { approved, skipped, duration } = result;

    // "once" — approve checked items for this invocation only; no rules created
    if (duration === "once") {
      // If some items were skipped, they remain unapproved — re-prompt for those
      if (skipped.length > 0) {
        const remainingRedirects = opts.check.redirectTargets?.filter(
          (rt) => skipped.includes(rt.path),
        );
        const newCheck: PermissionCheck = {
          ...opts.check,
          unapproved: skipped,
          action: "ask",
        };
        if (remainingRedirects && remainingRedirects.length > 0) {
          newCheck.redirectTargets = remainingRedirects;
        }
        opts.check = newCheck;
        reprompt = true;
        continue;
      }
      return undefined;
    }

    // For non-once durations, create rules for approved items
    const patterns: string[] = [];
    for (const [original, edited] of approved) {
      if (isFile) {
        const pattern = toRecursiveGlob(normalizePathForMatching(edited, opts.cwd));
        patterns.push(pattern);
      } else {
        patterns.push(edited);
      }
    }

    // Handle redirect target patterns
    const redirectPatterns: Array<{ permission: "read" | "edit"; pattern: string }> = [];
    if (opts.check.redirectTargets?.length) {
      for (const rt of opts.check.redirectTargets) {
        if (approved.has(rt.path)) {
          redirectPatterns.push({
            permission: rt.permission,
            pattern: toRecursiveGlob(normalizePathForMatching(rt.path, opts.cwd)),
          });
        }
      }
    }

    if (duration === "session" || duration === "project" || duration === "global") {
      const newModes: ProfileName[] = profile === "plan" ? ["plan", "build"] : ["build"];
      const newRules: Ruleset = patterns.map((p) => ({
        permission: opts.permission as Rule["permission"],
        pattern: p,
        action: "allow" as const,
        modes: newModes,
      }));

      for (const rp of redirectPatterns) {
        newRules.push({
          permission: rp.permission,
          pattern: rp.pattern,
          action: "allow" as const,
          modes: newModes,
        });
      }

      if (duration === "project") {
        await storage.addPersistedRules(newRules);
      } else if (duration === "global") {
        await storage.addGlobalRules(newRules);
      } else {
        storage.addSessionRules(newRules);
        pi.appendEntry("safetynet:session-rules", { rules: newRules });
      }
    } else {
      // "turn" or "timed"
      const expiryType = duration === "timed" ? "time" : "turn";

      const tempRules = makeTempRules({
        permission: opts.permission,
        patterns,
        profile,
        expiryType,
        minutes: timedMinutes,
      });

      for (const rp of redirectPatterns) {
        tempRules.push(...makeTempRules({
          permission: rp.permission,
          patterns: [rp.pattern],
          profile,
          expiryType,
          minutes: timedMinutes,
        }));
      }

      storage.addTempRules(tempRules);
    }

    // Recheck
    const recheckResult = opts.recheck();
    opts.check = recheckResult;
    if (recheckResult.action === "allow") return undefined;
    if (recheckResult.action === "deny") {
      ctx.ui.notify("Rule(s) added but still denied.", "warning");
      return { block: true, reason: "Still denied after rule update" };
    }

    // Still needs approval — re-prompt
    reprompt = true;
  }
}

async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: boolean; reason: string } | undefined> {
  try {
    const profile = getCurrentProfile();

    const cwd = ctx.cwd;

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      const rules = storage.getAllRules();
      const check = checkBashPermission(command, profile, rules, cwd);

      if (check.action === "deny") {
        ctx.abort();
        const detail = check.reason ?? `Denied by ruleset: ${(check.unapproved ?? []).join(", ")}`;
        ctx.ui.notify(`Command denied: ${command} (${detail})`, "error");
        return { block: true, reason: `Command denied: ${detail}` };
      }

      return resolvePermission(ctx, {
        permission: "bash",
        target: command,
        check,
        recheck: () => checkBashPermission(command, profile, storage.getAllRules(), cwd),
        cwd,
      });
    }

    if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
      const filePath = (event.input.path as string) ?? cwd;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "read",
        target: filePath,
        check: checkFileTarget(filePath, "read", profile, rules, cwd),
        recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd),
        cwd,
      });
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      if (profile === "plan") {
        ctx.abort();
        return { block: true, reason: `Plan mode: ${event.toolName} is disabled. The user must switch to build mode with /safetynet:build before implementation.` };
      }
      const filePath = event.input.path as string;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "edit",
        target: filePath,
        check: checkFileTarget(filePath, "edit", profile, rules, cwd),
        recheck: () => checkFileTarget(filePath, "edit", profile, storage.getAllRules(), cwd),
        cwd,
      });
    }

    if (event.toolName === "read") {
      const filePath = event.input.path as string;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "read",
        target: filePath,
        check: checkFileTarget(filePath, "read", profile, rules, cwd),
        recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd),
        cwd,
      });
    }

    const knownTools = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "questionnaire", "planWrite", "planEdit", "planPresent", "subagent_explore", "subagent_build"]);
    if (!knownTools.has(event.toolName) && profile === "plan") {
      return resolvePermission(ctx, {
        permission: "bash",
        target: `tool:${event.toolName}`,
        check: { action: "ask", reason: "Unknown tool in plan mode requires approval" },
        recheck: () => ({ action: "ask", reason: "Unknown tool in plan mode requires approval" }),
        cwd,
      });
    }
  } catch (err) {
    ctx.ui.notify(`Permission check error: ${err}`, "warning");
    return undefined;
  }
}

async function handleToolResult(event: ToolResultEvent, _ctx: ExtensionContext) {
  if (!isPlanOnErrorEnabled() || !event.isError || !isBashToolResult(event)) return;

  const instruction = getPlanOnErrorInstruction();
  if (!instruction) return;

  pi.sendMessage({
    customType: "safetynet:plan-on-error",
    content: instruction,
    display: false,
  });
}

/**
 * Swap the ephemeral context message in the message list.
 *
 * Removes any previous ephemeral message (identified by customType) and
 * appends the current one at the end. This ensures:
 * - Exactly one ephemeral message exists at any time
 * - It is always the last item before model generation (suffix position)
 * - All prior messages are an immutable, stable prefix for KV caching
 */
function swapEphemeralMessage(messages: AgentMessage[], ephemeralMessage: AgentMessage): AgentMessage[] {
  const filtered = messages.filter(
    (m) => (m as AgentMessage & { customType?: string }).customType !== EPHEMERAL_CUSTOM_TYPE,
  );
  filtered.push(ephemeralMessage);
  return filtered;
}

function formatPlanForDisplay(content: string): string {
  return `Plan ready for review.\n\n${content}`;
}

/** Read the plan file and return a present-result, or an error result if absent/empty. */
function readPlanForPresentation(sessionId: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; terminate: true } {
  const planPath = getPlanFilePath(sessionId);
  if (!existsSync(planPath)) {
    return {
      content: [{ type: "text", text: "No plan file found. Write your plan using planWrite first." }],
      details: {},
      terminate: true,
    };
  }

  const content = readFileSync(planPath, "utf-8").trim();
  if (!content) {
    return {
      content: [{ type: "text", text: "Plan file is empty. Write your plan using planWrite first." }],
      details: {},
      terminate: true,
    };
  }

  const markdown = formatPlanForDisplay(content);
  return {
    content: [{ type: "text", text: "Plan ready for review." }],
    details: { planPath, markdown },
    terminate: true,
  };
}

/** Build a visually distinct component for plan display. */
function buildPlanComponent(theme: Theme, content: string): Container {
  const container = new Container();

  // Header banner
  const header = new Text(theme.fg("accent", theme.bold("  📋 Plan — Awaiting Review")), 0, 0);
  container.addChild(header);

  // Separator
  const separator = new Text(theme.fg("borderAccent", "  ─────────────────────────────────────────"), 0, 0);
  container.addChild(separator);

  // Plan content (markdown)
  const md = new Markdown(content, 1, 0, getMarkdownTheme());
  container.addChild(md);

  // Wrap in a tinted box (cyan-tinted bg, tuned for dark themes)
  const box = new Box(0, 0, (s) => `\x1b[48;2;42;53;70m${s}\x1b[49m`);
  box.addChild(container);

  // Footer hint (outside the box so it's visually separate)
  const footer = new Text(theme.fg("muted", "  ↵ Reply with feedback, or run /safetynet:build to approve"), 0, 1);

  const outer = new Container();
  outer.addChild(box);
  outer.addChild(footer);
  return outer;
}

function renderPresentResult(result: { content: { type: string; text?: string }[]; details: unknown }, _options: unknown, theme: Theme) {
  const markdown = (result.details as { markdown?: unknown } | undefined)?.markdown;
  if (typeof markdown !== "string") {
    const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    return new Text(theme.fg("warning", text?.text ?? "No plan content"), 1, 0);
  }
  return buildPlanComponent(theme, markdown);
}

/** Render subagent tool call title bar with model info. */
function renderSubagentCall(
  label: string,
  args: { prompt: string; model?: string },
  theme: Theme,
) {
  let content = theme.fg("toolTitle", theme.bold(label));
  const modelDisplay = args.model ?? currentModelDisplay;
  if (modelDisplay) {
    content += theme.fg("muted", ` — ${modelDisplay}`);
  }
  return new Text(content, 0, 0);
}

/** Render subagent tool results with live activity feed during execution. */
function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
) {
  const details = result.details as { activities?: string[] } | undefined;
  const activities = details?.activities;
  const isPartial = options.isPartial;

  // During execution: show activity feed + text preview
  if (isPartial && activities && activities.length > 0) {
    const container = new Container();
    const maxShow = 3;
    const overflow = activities.length - maxShow;
    const shown = overflow > 0 ? activities.slice(-maxShow) : activities;
    if (overflow > 0) {
      container.addChild(new Text(theme.fg("muted", `  … +${overflow} earlier`), 0, 0));
    }
    for (const act of shown) {
      container.addChild(new Text(theme.fg("toolOutput", `  › ${act}`), 0, 0));
    }
    // If there's also text preview, show it below
    const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
    if (text?.trim()) {
      container.addChild(new Text(theme.fg("toolOutput", `  ${text.split("\n").slice(-6).join("\n  ")}`), 0, 0));
    }
    return container;
  }

  // Final result
  const expanded = options.expanded;
  const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
  if (!text) return undefined;

  if (!expanded) {
    // Collapsed: truncated preview + hint
    const lines = text.split("\n");
    const preview = lines.slice(-5).join("\n");
    let summary = "";
    if (activities && activities.length > 0) {
      const actSlice = activities.slice(-3);
      for (const act of actSlice) {
        summary += theme.fg("muted", `  › ${act}`) + "\n";
      }
    }
    summary += theme.fg("toolOutput", preview);
    summary += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
    return new Text(summary, 0, 0);
  }

  // Expanded: full output with activities and markdown
  const container = new Container();
  if (activities && activities.length > 0) {
    for (const act of activities) {
      container.addChild(new Text(theme.fg("muted", `  › ${act}`), 0, 0));
    }
    container.addChild(new Text("", 0, 0));
  }
  const mdTheme = getMarkdownTheme();
  container.addChild(new Markdown(text, 0, 0, mdTheme));
  return container;
}

function registerPlanTools(pi: ExtensionAPI) {
  const baseWriteAgentTool = createWriteTool(extDir);
  const baseEditAgentTool = createEditTool(extDir);

  pi.registerTool({
    name: "planWrite",
    label: "Plan Write",
    description: "Create or overwrite the plan file. Only include remaining work. If the plan is ready for the user's review, use presentToUser=true to automatically display it to them.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to write to the plan file" }),
      presentToUser: Type.Optional(Type.Boolean({ description: "If the plan is ready for the user's review, use presentToUser=true to automatically display it to them." })),
    }),
    renderResult: renderPresentResult,
    ...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      const result = await baseWriteAgentTool.execute(toolCallId, { path: planPath, content: params.content }, signal, onUpdate);

      if (params.presentToUser) {
        return readPlanForPresentation(ctx.sessionManager.getSessionId());
      }

      return {
        ...result,
        content: [{ type: "text", text: `Plan file updated at ${planPath}. Set presentToUser=true on your final planWrite to display it to the user.` }],
      };
    },
  });

  pi.registerTool({
    name: "planEdit",
    label: "Plan Edit",
    description: "Edit the plan file. Only include remaining work. If the plan is ready for the user's review, use presentToUser=true to automatically display it to them.",
    parameters: Type.Object({
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact text to replace" }),
        newText: Type.String({ description: "Replacement text" }),
      }), { description: "Edits to apply to the plan file" }),
      presentToUser: Type.Optional(Type.Boolean({ description: "If the plan is ready for the user's review, use presentToUser=true to automatically display it to them." })),
    }),
    renderResult: renderPresentResult,
    ...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      const result = await baseEditAgentTool.execute(toolCallId, { path: planPath, edits: params.edits } as any, signal, onUpdate);

      if (params.presentToUser) {
        return readPlanForPresentation(ctx.sessionManager.getSessionId());
      }

      return {
        ...result,
        content: [{ type: "text", text: `Plan file updated at ${planPath}. Set presentToUser=true on your final planEdit to display it to the user.` }],
      };
    },
  });

  pi.registerTool({
    name: "planPresent",
    label: "Plan Present",
    description: "Present the current plan to the user for review and end the turn. This does not switch modes; the user must run /safetynet:build to approve implementation.",
    parameters: Type.Object({
      confirmation: Type.Optional(Type.String({
        description: "Brief summary confirming the plan is ready for review",
      })),
    }),
    renderResult: renderPresentResult,
    ...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return readPlanForPresentation(ctx.sessionManager.getSessionId());
    },
  });
}

function switchToProfile(ctx: ExtensionContext, profile: ProfileName): void {
  const current = getCurrentProfile();
  if (current === profile) {
    ctx.ui.notify(`Already in ${profile} mode`, "info");
    return;
  }
  setCurrentProfile(profile);
  persistProfile(pi);
  ctx.ui.notify(`Switched from ${current} to ${profile} mode`, "info");
  updateStatus(ctx);

  // Leave a permanent mode-switch marker in the session.
  // This is NOT the ephemeral context — it's a tiny permanent record
  // that stays in the conversation prefix forever.
  pi.sendMessage({
    customType: "safetynet:mode-switch",
    content: `Switched to ${profile} mode`,
    display: true,
  });
}

function formatRules(rules: Ruleset): string[] {
  return rules.map((r) => `  ${r.permission}: ${r.pattern} -> ${r.action} (${r.modes.join(",")})`);
}

function showCurrentPlan(ctx: ExtensionContext): void {
  const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
  if (!existsSync(planPath)) {
    ctx.ui.notify("No plan file found for this session.", "info");
    return;
  }

  const content = readFileSync(planPath, "utf-8").trim();
  if (!content) {
    ctx.ui.notify("The current plan file is empty.", "info");
    return;
  }

  ctx.ui.setWidget("plan", (_tui, theme) => buildPlanComponent(theme, formatPlanForDisplay(content)));
}

function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("safetynet:plan-on-error", {
    description: "Toggle plan-on-error mode",
    handler: async (_args, ctx) => {
      const enabled = togglePlanOnError(pi);
      ctx.ui.notify(`Plan-on-error ${enabled ? "enabled" : "disabled"}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("safetynet:plan", {
    description: "Switch to plan mode",
    handler: async (_args, ctx) => switchToProfile(ctx, "plan"),
  });

  pi.registerCommand("safetynet:build", {
    description: "Switch to build mode (full access)",
    handler: async (_args, ctx) => switchToProfile(ctx, "build"),
  });

  pi.registerCommand("safetynet:plan-show", {
    description: "Show the current plan",
    handler: async (_args, ctx) => showCurrentPlan(ctx),
  });

  pi.registerCommand("safetynet:rules", {
    description: "Show current permission rules",
    handler: async (_args, ctx) => {
      const profile = getCurrentProfile();
      const baseline = getBaselineRules();
      const global = storage.global.getRules();
      const persisted = storage.persisted.getRules();
      const flag = storage.flag.getRules();
      const session = storage.session.getRules();
      const temp = storage.temp.getRules();

      const lines = [
        `Current profile: ${profile}`,
        `Plan-on-error: ${isPlanOnErrorEnabled() ? "enabled" : "disabled"}`,
        "",
        "Rules (last match wins):",
        "",
        "--- BASELINE ---",
        ...formatRules(baseline),
      ];

      if (global.length > 0) {
        lines.push("", "--- GLOBAL ---", ...formatRules(global));
      }

      if (persisted.length > 0) {
        lines.push("", "--- PERSISTED ---", ...formatRules(persisted));
      }

      if (flag.length > 0) {
        lines.push("", "--- FLAG (--allow) ---", ...formatRules(flag));
      }

      if (session.length > 0) {
        lines.push("", "--- SESSION ---", ...formatRules(session));
      }

      if (temp.length > 0) {
        lines.push("", "--- TEMPORARY ---", ...formatRules(temp));
      }

      lines.push("", `Approvals file: ${storage.persisted.getFilePath()}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function registerSubagentTools(pi: ExtensionAPI) {

	// subagent_explore is also available in plan mode
	// subagent_build is build-only

	// Get timed-approval-minutes flag for subagent build
	// (subagent uses parent's storage for rule propagation)
	function resolveModel(modelSpec: string | undefined, ctx: ExtensionContext) {
		if (!modelSpec) return ctx.model;
		const slashIdx = modelSpec.indexOf("/");
		if (slashIdx < 1) return ctx.model;
		const provider = modelSpec.slice(0, slashIdx);
		const modelId = modelSpec.slice(slashIdx + 1);
		return ctx.modelRegistry.find(provider, modelId) ?? ctx.model;
	}

	pi.registerTool({
		name: "subagent_explore",
		label: "Explore",
		description: "Spawn a read-only subagent to explore the codebase autonomously.\n\nWhen to use: searching the codebase, reading multiple files, tracing call chains, understanding architecture, answering questions about the code.\nWhen NOT to use: reading a single known file (use read), searching for a specific class (use find/grep), any task requiring file modification.\n\nKey properties:\n- Read-only: cannot modify files or run commands\n- Clean session: no conversation history — provide a complete, self-sufficient prompt\n- Runs in parallel: you can dispatch multiple explore agents simultaneously\n\nGuidance: Your prompt is the subagent's entire context. Be detailed and specific — tell it exactly what to find and how to report findings back.",
		promptSnippet: "Spawn a read-only subagent to explore the codebase",
		promptGuidelines: ["Use subagent_explore when you need to inspect or search the codebase in parallel. The subagent gets a clean session — provide a complete, self-sufficient prompt."],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete task description for the subagent" }),
			model: Type.Optional(Type.String({ description: "Model to use (format: provider/model-id, e.g. anthropic/claude-sonnet-4-20250514). Defaults to current model." })),
		}),
		renderResult: renderSubagentResult,
		renderCall: (args, theme) => renderSubagentCall("Subagent Explore", args, theme),
		...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runSubagent({
				taskType: "explore",
				prompt: params.prompt,
				parentCtx: ctx,
				parentStorage: storage,
				initialRules: storage.getAllRules(),
				signal,
				onUpdate,
				cwd: ctx.cwd,
				model: resolveModel(params.model, ctx),
			});
		},
	});

	pi.registerTool({
		name: "subagent_build",
		label: "Subagent Build",
		description: "Spawn a subagent with full build access. Permission prompts are shown to you for approval.\n\nWhen to use: self-contained implementation tasks that can be delegated to a focused agent.\nWhen NOT to use: trivial edits (do them directly), tasks requiring ongoing user interaction, tasks you can complete in a single tool call.\n\nKey properties:\n- Full access: read, write, edit, bash with your permission rules\n- Permission prompts routed to you: you approve or deny commands and file writes\n- Clean session: no conversation history — provide a complete, self-sufficient prompt\n\nGuidance: Include complete requirements in your prompt — file paths, expected behavior, verification commands. The subagent cannot ask you questions.",
		promptSnippet: "Delegate implementation work to a focused subagent",
		promptGuidelines: ["Use subagent_build when the task is self-contained and can be delegated to a focused agent. The subagent gets a clean session — provide a complete, self-sufficient prompt."],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete task description for the subagent" }),
			model: Type.Optional(Type.String({ description: "Model to use (format: provider/model-id, e.g. anthropic/claude-sonnet-4-20250514). Defaults to current model." })),
		}),
		renderResult: renderSubagentResult,
		renderCall: (args, theme) => renderSubagentCall("Subagent Build", args, theme),
		...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runSubagent({
				taskType: "build",
				prompt: params.prompt,
				parentCtx: ctx,
				parentStorage: storage,
				initialRules: storage.getAllRules(),
				signal,
				onUpdate,
				cwd: ctx.cwd,
				model: resolveModel(params.model, ctx),
			});
		},
	});
}

function registerShortcuts(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+\\", {
    description: "Toggle between plan and build profile",
    handler: async (ctx) => {
      const next: ProfileName = getCurrentProfile() === "plan" ? "build" : "plan";
      switchToProfile(ctx, next);
    },
  });

  pi.registerShortcut("ctrl+shift+\\", {
    description: "Show the current plan",
    handler: async (ctx) => showCurrentPlan(ctx),
  });
}

function updateStatus(ctx: ExtensionContext) {
  const profile = getCurrentProfile();
  const poe = isPlanOnErrorEnabled();
  let text = profile;
  if (poe) text += " +poe";
  ctx.ui.setStatus("safetynet", text);
}

let pi: ExtensionAPI;

interface RestoreOpts {
  init?: boolean;
  replaceSession?: boolean;
  notify?: boolean;
}

async function restoreSessionState(ctx: ExtensionContext, opts?: RestoreOpts): Promise<void> {
  if (opts?.init) await storage.init(ctx);
  restoreProfile(ctx);
  restorePlanOnError(ctx);

  const sessionRules = reconstructSessionRules(ctx);
  if (opts?.replaceSession) {
    const s = storage.session;
    s.clear();
    if (sessionRules.length > 0) s.addRules(sessionRules);
  } else {
    if (sessionRules.length > 0) storage.addSessionRules(sessionRules);
  }

  updateStatus(ctx);

  if (opts?.notify && ctx.hasUI) {
    ctx.ui.notify(`safetynet loaded in ${getCurrentProfile()} mode`, "info");
  }
}

export default function safetynetExtension(api: ExtensionAPI) {
  pi = api;
  storage = new PermissionStorage(pi, process.cwd());

  registerPlanTools(pi);
  questionnaire(pi);
	registerSubagentTools(pi);
  registerCommands(pi);
  registerShortcuts(pi);

  pi.registerFlag("build", {
    description: "Start in build mode (full access)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("plan-on-error", {
    description: "Enable plan-on-error mode",
    type: "boolean",
    default: true,
  });

  pi.registerFlag("timed-approval-minutes", {
    description: `Minutes for timed approval (default: ${DEFAULT_TIMED_APPROVAL_MINUTES})`,
    type: "string",
    default: String(DEFAULT_TIMED_APPROVAL_MINUTES),
  });

  pi.registerFlag("allow", {
    description: "Add temporary allow rules (comma-separated, format: \"permission: pattern\")",
    type: "string",
  });

  pi.on("model_select", async (event) => {
    currentModelDisplay = `${event.model.provider}/${event.model.id}`;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model) {
      currentModelDisplay = `${ctx.model.provider}/${ctx.model.id}`;
    }
    await restoreSessionState(ctx, { init: true, notify: true });

    // Ensure plans directory exists
    mkdirSync(plansDir, { recursive: true });

    // Headless: no UI for permission prompts or plan/build switching, so default to build
    if (!ctx.hasUI) {
      setCurrentProfile("build");
      persistProfile(pi);
      updateStatus(ctx);
    }

    if (pi.getFlag("build") === true) {
      setCurrentProfile("build");
      persistProfile(pi);
      updateStatus(ctx);
    }
    if (pi.getFlag("plan-on-error") === true) {
      setPlanOnError(true, pi);
      updateStatus(ctx);
    }
    const allowFlag = pi.getFlag("allow");
    if (typeof allowFlag === "string" && allowFlag.trim()) {
      const rules = parseAllowFlag(allowFlag);
      if (rules.length > 0) {
        storage.addFlagRules(rules);
      }
    }
  });

  pi.on("tool_call", handleToolCall);
  pi.on("tool_result", handleToolResult);

  // Clear turn-limited temp rules when the agent finishes (user gets a turn).
  pi.on("agent_end", async (_event, ctx) => {
    storage.temp.clearTurnRules();
  });

  // The context hook fires before every API call. We use it to swap the
  // ephemeral profile-context message: remove the old one, append the
  // current one. This keeps the message at the tail (suffix position),
  // maximizing the shared KV-cached prefix.
  pi.on("context", async (event) => {
    const profile = getCurrentProfile();
    const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
      role: "custom",
      customType: EPHEMERAL_CUSTOM_TYPE,
      content: getEphemeralContextMessage(profile),
      display: false,
      timestamp: Date.now(),
    };
    return { messages: swapEphemeralMessage(event.messages, ephemeralMessage) };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    // Clear stale plan widget from a previous turn
    ctx.ui.setWidget("plan", undefined);
  });

  pi.on("session_fork", async (_event, ctx) => {
    await restoreSessionState(ctx, { init: true, replaceSession: true });
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreSessionState(ctx, { replaceSession: true });
  });
}
