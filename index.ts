import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Rule, Ruleset, TempRule, ProfileName } from "./types.ts";
import { SwitchProfileParams } from "./types.ts";
import {
  getBaselineRules,
  PermissionStorage,
  reconstructSessionRules,
} from "./permissions/index.ts";
import {
  getCurrentProfile,
  setCurrentProfile,
  requiresApproval,
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
  showRulesEditor,
  promptProfileEscalation,
  notifyProfileSwitch,
  type PermissionChoice,
} from "./prompts.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./check.ts";
import { normalizePathForMatching, findProjectRoot, toDisplayPath, reanchorPattern } from "./project.ts";

let storage: PermissionStorage;

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

  let reprompt = false;
  while (true) {
    const promptOpts: { permission: "bash" | "edit" | "read"; target: string; unapproved?: string[]; redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>; reason?: string; timedApprovalMinutes?: number; reprompt?: boolean } = {
      permission: opts.permission,
      target: opts.target,
      timedApprovalMinutes: timedMinutes,
      reprompt,
    };
    if (opts.check.unapproved && opts.check.unapproved.length > 0) promptOpts.unapproved = opts.check.unapproved;
    if (opts.check.redirectTargets?.length) promptOpts.redirectTargets = opts.check.redirectTargets;
    if (opts.check.reason) promptOpts.reason = opts.check.reason;
    const choice = await showPermissionPrompt(ctx, promptOpts);

    if (choice === "deny") {
      ctx.abort();
      return { block: true, reason: `User denied ${opts.permission}` };
    }

    if (choice === "once") return undefined;

    if (choice === "timed" || choice === "turn") {
      const isFile = opts.permission === "read" || opts.permission === "edit";
      const root = findProjectRoot(process.cwd());
      const cwd = process.cwd();

      const patterns = isFile
        ? [normalizePathForMatching(opts.target, root)]
        : (opts.check.unapproved?.length ? opts.check.unapproved : [opts.target]);

      const tempRules = makeTempRules({
        permission: opts.permission,
        patterns,
        profile,
        expiryType: choice === "timed" ? "time" : "turn",
        minutes: timedMinutes,
      });

      // Also add redirect target patterns as temp rules
      if (opts.check.redirectTargets?.length) {
        for (const rt of opts.check.redirectTargets) {
          tempRules.push(...makeTempRules({
            permission: rt.permission,
            patterns: [normalizePathForMatching(rt.path, root)],
            profile,
            expiryType: choice === "timed" ? "time" : "turn",
            minutes: timedMinutes,
          }));
        }
      }

      storage.addTempRules(tempRules);

      const recheckResult = opts.recheck();
      opts.check = recheckResult;
      if (recheckResult.action === "allow") return undefined;
      if (recheckResult.action === "deny") {
        ctx.ui.notify("Temp rule(s) added but still denied.", "warning");
        return { block: true, reason: "Still denied after temp rule update" };
      }

      reprompt = true;
      continue;
    }

    // choice === "edit"
    const isFile = opts.permission === "read" || opts.permission === "edit";
    const root = findProjectRoot(process.cwd());
    const editorItems = isFile
      ? [opts.target]
      : (opts.check.unapproved?.length ? opts.check.unapproved : [opts.target]);
    const edited = await showRulesEditor(ctx, editorItems, isFile);
    if (edited === null) { reprompt = true; continue; }

    // Convert cwd-relative patterns back to project-root-relative for storage
    const cwd = process.cwd();
    const patternsForStorage = isFile
      ? edited.patterns.map((p) => reanchorPattern(p, cwd, root))
      : edited.patterns;

    const newModes: ProfileName[] = profile === "plan" ? ["plan", "build"] : ["build"];
    const newRules: Ruleset = patternsForStorage.map((p) => ({
      permission: opts.permission as Rule["permission"],
      pattern: p,
      action: "allow" as const,
      modes: newModes,
    }));

    if (opts.check.redirectTargets?.length) {
      for (const rt of opts.check.redirectTargets) {
        newRules.push({
          permission: rt.permission,
          pattern: normalizePathForMatching(rt.path, root),
          action: "allow" as const,
          modes: newModes,
        });
      }
    }

    if (edited.persist === "persisted") {
      await storage.addPersistedRules(newRules);
    } else {
      storage.addSessionRules(newRules);
      pi.appendEntry("spfy:session-rules", { rules: newRules });
    }

    const recheckResult = opts.recheck();
    opts.check = recheckResult;
    if (recheckResult.action === "allow") return undefined;
    if (recheckResult.action === "deny") {
      ctx.ui.notify("Rule(s) added but still denied.", "warning");
      return { block: true, reason: "Still denied after rule update" };
    }

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
        return { block: true, reason: `Plan mode: ${event.toolName} is disabled. Use switchProfile with target "build" to request build mode.` };
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

    const knownTools = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "questionnaire", "switchProfile"]);
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
    if (msg.customType === "spfy:profile:context") return false;

    if (msg.role === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        return !hasPlanOnErrorMarker(content) && !content.includes("[SPFY_PROFILE_CONTEXT]") && !content.includes("[SPFY PLAN MODE]") && !content.includes("[SPFY BUILD MODE]");
      }
    }
    return true;
  });
}

function registerSwitchProfileTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "switchProfile",
    label: "Switch Profile",
    description:
      "Switch between plan (read-only, planning) and build (full access) profiles. Escalation from plan to build requires user approval. Deescalation from build to plan is automatic.",
    parameters: SwitchProfileParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = getCurrentProfile();
      const target = params.target as ProfileName;

      if (current === target) {
        return {
          content: [{ type: "text", text: `Already in ${target} mode.` }],
          details: {},
        };
      }

      if (requiresApproval(current, target)) {
        const approved = await promptProfileEscalation(ctx, params.reason);
        if (!approved) {
          ctx.abort();
          return {
            content: [
              { type: "text", text: `Profile switch denied. Staying in ${current} mode.` },
            ],
            details: {},
          };
        }
      }

      previousProfile = current;
      setCurrentProfile(target);
      persistProfile(pi);
      applyProfileTools(pi, target);
      notifyProfileSwitch(ctx, current, target);
      updateStatus(ctx);

      // setActiveTools only takes effect on the next turn (Pi snapshots
      // the tool list at turn start). So we terminate the current turn
      // and trigger a fresh one — the new turn picks up the updated
      // tool list and gets the build-mode context from before_agent_start.
      const contextMessage = getProfileContextMessage(target, current);

      pi.sendMessage(
        {
          customType: "spfy:profile:context",
          content: contextMessage,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      return {
        content: [
          {
            type: "text",
            text: `Switched to ${target} mode.${params.reason ? ` Reason: ${params.reason}` : ""}`,
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });
}

let previousProfile: ProfileName | undefined;

function switchToProfile(ctx: ExtensionContext, profile: ProfileName): void {
  const current = getCurrentProfile();
  if (current === profile) {
    ctx.ui.notify(`Already in ${profile} mode`, "info");
    return;
  }
  previousProfile = current;
  setCurrentProfile(profile);
  persistProfile(pi);
  applyProfileTools(pi, profile);
  ctx.ui.notify(`Switched to ${profile} mode`, "info");
  updateStatus(ctx);
}

function formatRules(rules: Ruleset): string[] {
  return rules.map((r) => `  ${r.permission}: ${r.pattern} -> ${r.action} (${r.modes.join(",")})`);
}

function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("spfy:plan-on-error", {
    description: "Toggle plan-on-error mode",
    handler: async (_args, ctx) => {
      const enabled = togglePlanOnError(pi);
      ctx.ui.notify(`Plan-on-error ${enabled ? "enabled" : "disabled"}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("spfy:plan", {
    description: "Switch to plan mode (approval required)",
    handler: async (_args, ctx) => switchToProfile(ctx, "plan"),
  });

  pi.registerCommand("spfy:build", {
    description: "Switch to build mode (full access)",
    handler: async (_args, ctx) => switchToProfile(ctx, "build"),
  });

  pi.registerCommand("spfy:rules", {
    description: "Show current permission rules",
    handler: async (_args, ctx) => {
      const profile = getCurrentProfile();
      const baseline = getBaselineRules();
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
}

function updateStatus(ctx: ExtensionContext) {
  const profile = getCurrentProfile();
  const poe = isPlanOnErrorEnabled();
  let text = profile;
  if (poe) text += " +poe";
  ctx.ui.setStatus("spfy", text);
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
    ctx.ui.notify(`spfy loaded in ${getCurrentProfile()} mode`, "info");
  }
}

export default function spfyExtension(api: ExtensionAPI) {
  pi = api;
  storage = new PermissionStorage(pi, process.cwd());

  registerSwitchProfileTool(pi);
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

    if (pi.getFlag("build") === true) {
      setCurrentProfile("build");
      updateStatus(ctx);
    }
    if (pi.getFlag("plan-on-error") === true) {
      setPlanOnError(true, pi);
      updateStatus(ctx);
    }
  });

  pi.on("tool_call", handleToolCall);
  pi.on("tool_result", handleToolResult);

  // Clear turn-limited temp rules when the agent finishes (user gets a turn)
  pi.on("agent_end", async () => {
    storage.temp.clearTurnRules();
  });

  pi.on("context", async (event) => {
    return { messages: filterProfileContext(event.messages) };
  });

  pi.on("before_agent_start", async () => {
    const profile = getCurrentProfile();
    const prev = previousProfile;
    previousProfile = undefined;
    return {
      message: {
        customType: "spfy:profile:context",
        content: getProfileContextMessage(profile, prev),
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
