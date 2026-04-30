import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Rule, Ruleset, ProfileName, PermissionAction } from "./types.js";
import { SwitchProfileParams } from "./types.js";
import {
  evaluatePermission,
  getBaselineRules,
  PermissionStorage,
  reconstructSessionRules,
} from "./permissions/index.js";
import {
  getCurrentProfile,
  setCurrentProfile,
  requiresApproval,
  getProfileContextMessage,
  persistProfile,
  restoreProfile,
  applyProfileTools,
} from "./profiles/index.js";
import {
  isPlanOnErrorEnabled,
  setPlanOnError,
  togglePlanOnError,
  restorePlanOnError,
  getPlanOnErrorInstruction,
  hasPlanOnErrorMarker,
} from "./profiles/plan-on-error.js";
import {
  getPlanModeBlockMessage,
  showPermissionPrompt,
  showRulesEditor,
  promptProfileEscalation,
  notifyProfileSwitch,
  getStatusText,
} from "./prompts.js";
import {
  getAllCommands,
  hasFileRedirects,
  isCatastrophicCommand,
  isHazardousFile,
} from "./bash-parser.js";
import { findProjectRoot, isExternalPath, normalizePathForMatching } from "./project.js";

let storage: PermissionStorage;

function checkBashPermission(
  command: string,
  profile: ProfileName,
): { action: PermissionAction; unapproved: string[] } {
  const rules = storage.getAllRules();

  if (isCatastrophicCommand(command)) {
    return { action: "deny", unapproved: [] };
  }

  const subcommands = getAllCommands(command);

  const unapproved: string[] = [];
  let worstAction: PermissionAction = "allow";

  for (const sub of subcommands) {
    const result = evaluatePermission("bash", sub, profile, rules);
    if (result.action === "deny") {
      worstAction = "deny";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    } else if (result.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    }
  }

  if (hasFileRedirects(command)) {
    const redirectResult = evaluatePermission("edit", command, profile, rules);
    if (redirectResult.action === "deny" && worstAction !== "deny") {
      worstAction = "deny";
    } else if (redirectResult.action === "ask" && worstAction === "allow") {
      worstAction = "ask";
    }
  }

  return { action: worstAction, unapproved };
}

function checkFilePermission(
  permission: "read" | "edit",
  filePath: string,
  profile: ProfileName,
): { action: PermissionAction; reason?: string } {
  const rules = storage.getAllRules();

  if (isHazardousFile(filePath)) {
    return { action: "deny", reason: "Hazardous file (e.g., .env)" };
  }

  const projectRoot = findProjectRoot(process.cwd());
  if (isExternalPath(filePath, projectRoot)) {
    return { action: "ask", reason: "Path is outside project root" };
  }

  const normalized = normalizePathForMatching(filePath, projectRoot);
  const result = evaluatePermission(permission, normalized, profile, rules);
  return { action: result.action };
}

async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: boolean; reason: string } | undefined> {
  const profile = getCurrentProfile();

  if (event.toolName === "bash") {
    const command = event.input.command as string;
    const check = checkBashPermission(command, profile);

    if (check.action === "deny") {
      ctx.abort();
      if (profile === "plan") {
        return { block: true, reason: getPlanModeBlockMessage(command, "bash") };
      }
      ctx.ui.notify(`Command denied: ${command}`, "error");
      return { block: true, reason: "Command denied by ruleset" };
    }

    if (check.action === "ask") {
      if (profile === "plan") {
        return { block: true, reason: getPlanModeBlockMessage(command, "bash") };
      }

      while (true) {
        const choice = await showPermissionPrompt(ctx, {
          permission: "bash",
          target: command,
          unapproved: check.unapproved,
        });

        if (choice === "deny") {
          ctx.abort();
          return { block: true, reason: "User denied bash command" };
        }

        if (choice === "once") {
          return undefined;
        }

        const edited = await showRulesEditor(ctx, check.unapproved);
        if (edited === null) continue;

        const newRules: Ruleset = edited.patterns.map((p) => ({
          permission: "bash" as const,
          pattern: p,
          action: "allow" as const,
          modes: ["build"] as ProfileName[],
        }));

        if (edited.persist === "persisted") {
          await storage.addPersistedRules(newRules);
        } else {
          storage.addSessionRules(newRules);
          pi.appendEntry("spfy:session-rules", { rules: newRules });
        }

        const recheck = checkBashPermission(command, profile);
        if (recheck.action === "allow") return undefined;
        if (recheck.action === "deny") {
          ctx.ui.notify(`Rule(s) added but command still denied.`, "warning");
          return { block: true, reason: "Command still denied after rule update" };
        }

        ctx.ui.notify(
          `Rule(s) added but some commands still need approval. Re-prompting...`,
          "warning",
        );
      }
    }

    return undefined;
  }

  if (event.toolName === "read") {
    const filePath = event.input.path as string;
    const check = checkFilePermission("read", filePath, profile);

    if (check.action === "deny") {
      ctx.abort();
      return {
        block: true,
        reason: `Read denied: ${check.reason ?? "Not allowed"}`,
      };
    }

    if (check.action === "ask") {
      if (profile === "plan") {
        return { block: true, reason: getPlanModeBlockMessage(filePath, "read") };
      }

      while (true) {
        const choice = await showPermissionPrompt(ctx, {
          permission: "read",
          target: filePath,
          reason: check.reason,
        });

        if (choice === "deny") {
          ctx.abort();
          return { block: true, reason: "User denied read" };
        }
        if (choice === "once") return undefined;

        const edited = await showRulesEditor(ctx, [filePath]);
        if (edited === null) continue;

        const newRules: Ruleset = edited.patterns.map((p) => ({
          permission: "read" as const,
          pattern: p,
          action: "allow" as const,
          modes: ["build"] as ProfileName[],
        }));

        if (edited.persist === "persisted") {
          await storage.addPersistedRules(newRules);
        } else {
          storage.addSessionRules(newRules);
        }

        const recheck = checkFilePermission("read", filePath, profile);
        if (recheck.action === "allow") return undefined;

        ctx.ui.notify(
          `Pattern doesn't match "${filePath}". Try again or select "Allow once".`,
          "warning",
        );
      }
    }

    return undefined;
  }

  if (event.toolName === "edit" || event.toolName === "write") {
    const filePath = event.input.path as string;

    if (profile === "plan") {
      ctx.abort();
      return { block: true, reason: getPlanModeBlockMessage(filePath, event.toolName) };
    }

    const check = checkFilePermission("edit", filePath, profile);

    if (check.action === "deny") {
      ctx.abort();
      return {
        block: true,
        reason: `Edit denied: ${check.reason ?? "Not allowed"}`,
      };
    }

    if (check.action === "ask") {
      while (true) {
        const choice = await showPermissionPrompt(ctx, {
          permission: "edit",
          target: filePath,
          reason: check.reason,
        });

        if (choice === "deny") {
          ctx.abort();
          return { block: true, reason: "User denied edit" };
        }
        if (choice === "once") return undefined;

        const edited = await showRulesEditor(ctx, [filePath]);
        if (edited === null) continue;

        const newRules: Ruleset = edited.patterns.map((p) => ({
          permission: "edit" as const,
          pattern: p,
          action: "allow" as const,
          modes: ["build"] as ProfileName[],
        }));

        if (edited.persist === "persisted") {
          await storage.addPersistedRules(newRules);
        } else {
          storage.addSessionRules(newRules);
        }

        const recheck = checkFilePermission("edit", filePath, profile);
        if (recheck.action === "allow") return undefined;

        ctx.ui.notify(
          `Pattern doesn't match "${filePath}". Try again or select "Allow once".`,
          "warning",
        );
      }
    }

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
        return !hasPlanOnErrorMarker(content) && !content.includes("[SPFY_PROFILE_CONTEXT]");
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
      "Switch between plan (read-only) and build (full access) profiles",
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
          return {
            content: [
              { type: "text", text: `Profile switch denied. Staying in ${current} mode.` },
            ],
            details: {},
          };
        }
      }

      setCurrentProfile(target);
      persistProfile(pi);
      applyProfileTools(pi, target);
      notifyProfileSwitch(ctx, current, target);

      return {
        content: [
          {
            type: "text",
            text: `Switched to ${target} mode.${params.reason ? ` Reason: ${params.reason}` : ""}`,
          },
        ],
        details: {},
      };
    },
  });
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
    description: "Switch to plan mode (read-only)",
    handler: async (_args, ctx) => {
      const current = getCurrentProfile();
      if (current === "plan") {
        ctx.ui.notify("Already in plan mode", "info");
        return;
      }
      setCurrentProfile("plan");
      persistProfile(pi);
      applyProfileTools(pi, "plan");
      ctx.ui.notify("Switched to plan mode", "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("spfy:build", {
    description: "Switch to build mode (full access)",
    handler: async (_args, ctx) => {
      const current = getCurrentProfile();
      if (current === "build") {
        ctx.ui.notify("Already in build mode", "info");
        return;
      }
      setCurrentProfile("build");
      persistProfile(pi);
      applyProfileTools(pi, "build");
      ctx.ui.notify("Switched to build mode", "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("spfy:rules", {
    description: "Show current permission rules",
    handler: async (_args, ctx) => {
      const profile = getCurrentProfile();
      const baseline = getBaselineRules();
      const persisted = storage.persisted.getRules();
      const session = storage.session.getRules();

      const lines = [
        `Current profile: ${profile}`,
        `Plan-on-error: ${isPlanOnErrorEnabled() ? "enabled" : "disabled"}`,
        "",
        "Rules (last match wins):",
        "",
        "--- BASELINE ---",
      ];

      for (const rule of baseline) {
        const modes = rule.modes?.join(",") ?? "all";
        lines.push(`  ${rule.permission}: ${rule.pattern} -> ${rule.action} (${modes})`);
      }

      if (persisted.length > 0) {
        lines.push("", "--- PERSISTED ---");
        for (const rule of persisted) {
          const modes = rule.modes?.join(",") ?? "all";
          lines.push(`  ${rule.permission}: ${rule.pattern} -> ${rule.action} (${modes})`);
        }
      }

      if (session.length > 0) {
        lines.push("", "--- SESSION ---");
        for (const rule of session) {
          const modes = rule.modes?.join(",") ?? "all";
          lines.push(`  ${rule.permission}: ${rule.pattern} -> ${rule.action} (${modes})`);
        }
      }

      lines.push("", `Approvals file: ${storage.persisted.getFilePath()}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function updateStatus(ctx: ExtensionContext) {
  const profile = getCurrentProfile();
  const poe = isPlanOnErrorEnabled();
  ctx.ui.setStatus("spfy", getStatusText(profile, poe));
}

let pi: ExtensionAPI;

export default function spfyExtension(api: ExtensionAPI) {
  pi = api;
  storage = new PermissionStorage(pi, process.cwd());

  registerSwitchProfileTool(pi);
  registerCommands(pi);

  pi.registerFlag("build", {
    description: "Start in build mode (full access)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("plan-on-error", {
    description: "Enable plan-on-error mode",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (_event, ctx) => {
    await storage.init(ctx);
    restoreProfile(ctx);
    restorePlanOnError(ctx);

    if (pi.getFlag("build") === true) {
      setCurrentProfile("build");
    }
    if (pi.getFlag("plan-on-error") === true) {
      setPlanOnError(true, pi);
    }

    const sessionRules = reconstructSessionRules(ctx);
    if (sessionRules.length > 0) {
      storage.addSessionRules(sessionRules);
    }

    applyProfileTools(pi, getCurrentProfile());
    updateStatus(ctx);

    if (ctx.hasUI) {
      const profile = getCurrentProfile();
      ctx.ui.notify(`spfy loaded in ${profile} mode`, "info");
    }
  });

  pi.on("tool_call", handleToolCall);
  pi.on("tool_result", handleToolResult);

  pi.on("context", async (event) => {
    return { messages: filterProfileContext(event.messages) };
  });

  pi.on("before_agent_start", async () => {
    const profile = getCurrentProfile();
    return {
      message: {
        customType: "spfy:profile:context",
        content: getProfileContextMessage(profile),
        display: false,
      },
    };
  });

  pi.on("session_fork", async (_event, ctx) => {
    await storage.init(ctx);
    restoreProfile(ctx);
    restorePlanOnError(ctx);
    applyProfileTools(pi, getCurrentProfile());
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreProfile(ctx);
    restorePlanOnError(ctx);

    const sessionRules = reconstructSessionRules(ctx);
    const s = storage.session;
    s.clear();
    if (sessionRules.length > 0) s.addRules(sessionRules);

    applyProfileTools(pi, getCurrentProfile());
    updateStatus(ctx);
  });
}
