import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createEditTool,
  createWriteTool,
  getMarkdownTheme,
  isBashToolResult,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule, Ruleset, TempRule, ProfileName } from "./types.ts";
import questionnaire from "./questionnaire.ts";
import {
  getBaselineRules,
  PermissionStorage,
  reconstructSessionRules,
} from "./permissions/index.ts";
import {
  getCurrentProfile,
  setCurrentProfile,
  getProfileContextMessage,
  persistProfile,
  restoreProfile,
  applyProfileTools,
} from "./profiles/index.ts";
import {
  isPlanOnErrorEnabled,
  setPlanOnError,
  togglePlanOnError,
  restorePlanOnError,
  getPlanOnErrorInstruction,
  hasPlanOnErrorMarker,
} from "./profiles/plan-on-error.ts";
import {
  showPermissionPrompt,
} from "./prompts.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./check.ts";
import { normalizePathForMatching, findProjectRoot } from "./project.ts";

let storage: PermissionStorage;

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

async function resolvePermission(
  ctx: ExtensionContext,
  opts: {
    permission: "bash" | "read" | "edit";
    target: string;
    check: PermissionCheck;
    recheck: () => PermissionCheck;
  },
): Promise<{ block: boolean; reason: string } | undefined> {
  const { action } = opts.check;

  if (action === "allow") return undefined;

  if (action === "deny") {
    ctx.abort();
    const label = opts.permission[0]!.toUpperCase() + opts.permission.slice(1);
    return { block: true, reason: `${label} denied: ${opts.check.reason ?? "no matching allow rule"}` };
  }

  const profile = getCurrentProfile();
  const timedMinutes = getTimedApprovalMinutes();
  const root = findProjectRoot(process.cwd());
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
        patterns.push(normalizePathForMatching(edited, root));
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
            pattern: normalizePathForMatching(rt.path, root),
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

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      const rules = storage.getAllRules();
      const check = checkBashPermission(command, profile, rules);

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
        recheck: () => checkBashPermission(command, profile, storage.getAllRules()),
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
        check: checkFileTarget(filePath, "edit", profile, rules),
        recheck: () => checkFileTarget(filePath, "edit", profile, storage.getAllRules()),
      });
    }

    if (event.toolName === "read") {
      const filePath = event.input.path as string;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "read",
        target: filePath,
        check: checkFileTarget(filePath, "read", profile, rules),
        recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules()),
      });
    }

    const knownTools = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "questionnaire", "planWrite", "planEdit", "planPresent"]);
    if (!knownTools.has(event.toolName) && profile === "plan") {
      return resolvePermission(ctx, {
        permission: "bash",
        target: `tool:${event.toolName}`,
        check: { action: "ask", reason: "Unknown tool in plan mode requires approval" },
        recheck: () => ({ action: "ask", reason: "Unknown tool in plan mode requires approval" }),
      });
    }
  } catch (err) {
    ctx.ui.notify(`Permission check error: ${err}`, "warning");
    return undefined;
  }
}

async function handleToolResult(event: ToolResultEvent, _ctx: ExtensionContext) {
  if (!isPlanOnErrorEnabled() || !isBashToolResult(event)) return;

  const instruction = getPlanOnErrorInstruction();
  if (!instruction) return;

  const content = event.content;
  if (Array.isArray(content)) {
    const textContent = content.find(
      (c): c is { type: "text"; text: string } => c.type === "text",
    );
    if (textContent) {
      textContent.text += `\n\n${instruction}`;
    }
  }
}

function filterProfileContext(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => {
    const msg = m as AgentMessage & { customType?: string };
    if (msg.customType === "safetynet:profile:context") return false;

    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        return !hasPlanOnErrorMarker(content) && !content.includes("[SAFENET_PROFILE_CONTEXT]") && !content.includes("[SAFENET PLAN MODE]") && !content.includes("[SAFENET BUILD MODE]");
      }
    }
    return true;
  });
}

function formatPlanForDisplay(content: string): string {
  return `Plan ready for review.\n\n${content}\n\nIf you want revisions, reply with feedback. If you approve, switch to build mode with /safetynet:build and tell me to begin.`;
}

function registerPlanTools(pi: ExtensionAPI) {
  const baseWriteAgentTool = createWriteTool(extDir);
  const baseEditAgentTool = createEditTool(extDir);

  pi.registerTool({
    name: "planWrite",
    label: "Plan Write",
    description: "Create or overwrite the plan file. Use planPresent when the plan is ready to show the full plan to the user.",
    parameters: Type.Object({
      content: Type.String({ description: "Content to write to the plan file" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      const result = await baseWriteAgentTool.execute(toolCallId, { path: planPath, content: params.content }, signal, onUpdate);
      return {
        ...result,
        content: [{ type: "text", text: `Plan file updated at ${planPath}. Call planPresent when the plan is ready to show it to the user.` }],
      };
    },
  });

  pi.registerTool({
    name: "planEdit",
    label: "Plan Edit",
    description: "Edit the plan file. Use planPresent when the plan is ready to show the full plan to the user.",
    parameters: Type.Object({
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact text to replace" }),
        newText: Type.String({ description: "Replacement text" }),
      }), { description: "Edits to apply to the plan file" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      const result = await baseEditAgentTool.execute(toolCallId, { path: planPath, edits: params.edits } as any, signal, onUpdate);
      return {
        ...result,
        content: [{ type: "text", text: `Plan file updated at ${planPath}. Call planPresent when the plan is ready to show it to the user.` }],
      };
    },
  });

  pi.registerTool({
    name: "planPresent",
    label: "Plan Present",
    description: "Present the current plan to the user for review and end the turn. Call this when the plan is complete. This does not switch modes; the user must run /safetynet:build to approve implementation.",
    parameters: Type.Object({}),
    renderResult(result) {
      const markdown = (result.details as { markdown?: unknown } | undefined)?.markdown;
      if (typeof markdown !== "string") {
        const text = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
        return new Text(text?.text ?? "No plan content", 0, 0);
      }
      return new Markdown(markdown, 0, 0, getMarkdownTheme());
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      if (!existsSync(planPath)) {
        return {
          content: [{ type: "text", text: "No plan file found. Write your plan using planWrite before calling planPresent." }],
          details: {},
          terminate: true,
        };
      }

      const content = readFileSync(planPath, "utf-8").trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "Plan file is empty. Write your plan using planWrite before calling planPresent." }],
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
  applyProfileTools(pi, profile);
  ctx.ui.notify(`Switched from ${current} to ${profile} mode`, "info");
  updateStatus(ctx);
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

  ctx.ui.notify(formatPlanForDisplay(content), "info");
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

  applyProfileTools(pi, getCurrentProfile());
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

  pi.on("session_start", async (_event, ctx) => {
    await restoreSessionState(ctx, { init: true, notify: true });

    // Ensure plans directory exists
    mkdirSync(plansDir, { recursive: true });

    if (pi.getFlag("build") === true) {
      setCurrentProfile("build");
      persistProfile(pi);
      applyProfileTools(pi, "build");
      updateStatus(ctx);
    }
    if (pi.getFlag("plan-on-error") === true) {
      setPlanOnError(true, pi);
      updateStatus(ctx);
    }
  });

  pi.on("tool_call", handleToolCall);
  pi.on("tool_result", handleToolResult);

  // Clear turn-limited temp rules when the agent finishes (user gets a turn).
  pi.on("agent_end", async () => {
    storage.temp.clearTurnRules();
  });

  pi.on("context", async (event) => {
    return { messages: filterProfileContext(event.messages) };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const profile = getCurrentProfile();
    const sessionId = ctx.sessionManager.getSessionId();
    const planPath = getPlanFilePath(sessionId);
    return {
      message: {
        customType: "safetynet:profile:context",
        content: getProfileContextMessage(profile, planPath),
        display: false,
      },
    };
  });

  pi.on("session_fork", async (_event, ctx) => {
    await restoreSessionState(ctx, { init: true, replaceSession: true });
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreSessionState(ctx, { replaceSession: true });
  });
}
