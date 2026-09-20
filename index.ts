import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text } from "@earendil-works/pi-tui";
import {
  createEditTool,
  createWriteTool,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptKeybindings } from "./core/types.ts";
import type { Rule, Ruleset, TempRule, ProfileName, PermissionAction, KeybindingsConfig, AutoDenyConfig } from "./core/types.ts";
import questionnaire from "./questionnaire.ts";
import { renderCustomFooter } from "./footer.ts";
import { loadSubagentsConfig, loadTrustExternalPaths, loadDefaultProfile, loadParadigm, loadKeybindings, loadAutoDeny, loadToggleModeKey } from "./core/global-config.ts";
import { evaluatePermission } from "./core/permissions/ruleset.ts";
import { runSubagent, addUsage, formatSubagentUsage, ZERO_USAGE, type SubagentUsage } from "./subagent.ts";
import {
  getBaselineRules,
  PermissionStorage,
  reconstructSessionRules,
} from "./core/permissions/index.ts";
import {
  getCurrentProfile,
  setCurrentProfile,
  MODE_REMINDER_CUSTOM_TYPE,
  getModeSystemPrompt,
  getModeSwitchMessage,
  getSessionModeMessage,
  persistProfile,
  restoreProfile,
  getLatestCustomEntry,
  getParadigm,
  setParadigm,
  getModeAliases,
  normalizeProfile,
  isReadOnly,
  paradigmModes,
} from "./core/profiles.ts";
import {
  showPermissionPrompt,
  type PermissionPromptResult,
} from "./prompts.ts";
import { checkBashPermission, checkFileTarget, checkToolPermission, type PermissionCheck } from "./core/check.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./core/project.ts";
import { resolvePermission as resolvePermissionShared, makeTempRule, headlessDeny as hd, denyResultFromPrompt as drfp, resolveDeny, strikeDeny, type HazardousDenyState } from "./pipeline.ts";
import { isAutoEnabled, toggleAutoEnabled, restoreAutoEnabled, resetAutoEnabledForNewSession, setAutoEnabled, loadAutoApproveConfig } from "./core/auto-config-state.ts";
import { InferredEngine } from "./core/inferred/engine.ts";
import { uiArbiter } from "./core/ui-arbiter.ts";
import { JUDGE_SYSTEM_PROMPT } from "./core/inferred/judge.ts";
import { loadLearnedBoundaries } from "./core/inferred/learned.ts";
import { reviewBumpTurnToken, reviewResetDenies, resolveModelSpec } from "./core/reviewer-state.ts";
/** Re-exported pure seams for test compatibility. */
export const headlessDeny = hd;
export const denyResultFromPrompt = drfp;
export { makeTempRule } from "./pipeline.ts";

/** Thin wrapper: translates module state into PipelineDeps and delegates. */
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
  const profile = getCurrentProfile();
  const { read, write } = paradigmModes();
  const allowModes: ProfileName[] = profile === write ? [write] : [read, write];
  return resolvePermissionShared(
    {
      displayCtx: ctx,
      storage,
      cwd: opts.cwd,
      allowModes,
      keybindings: promptKeybindings,
      autoDeny: autoDenyConfig,
      hazardousDenyState,
      ...(inferredEngine ? { inferred: wireInferred(ctx) } : {}),
      sendManualApproval: () => {
        pi.sendMessage({
          customType: "safetynet:manual-approval",
          content: "The user manually approved this command by interactive prompt.",
          display: false,
        });
      },
      sendDenial,
      appendSessionRules: (rules, cwd) => {
        pi.appendEntry("safetynet:session-rules", { rules, cwd });
      },
    },
    opts,
  );
}

/** Bind the inferred engine to the live session context (judge adapter on
 *  runSubagent, suppression predicate, UI hooks). Cheap per call. */
function wireInferred(ctx: ExtensionContext): InferredEngine {
	const engine = inferredEngine!; // caller guards
	engine.judgeDeps = {
		ask: (prompt: string) => {
			// Judge uses the same autoApprove.model key as the reviewer (plan
			// decision #13), resolved against the parent catalog; degrades to the
			// session model when unset or unresolvable.
			const spec = loadAutoApproveConfig().model;
			const first = Array.isArray(spec) ? spec[0] : spec;
			return runSubagent({
				taskType: "explore",
				prompt,
				systemPrompt: JUDGE_SYSTEM_PROMPT,
				cwd: ctx.cwd,
				parentCtx: ctx,
				parentStorage: storage,
				initialRules: [],
				promptKeybindings: promptKeybindings,
				autoDenyConfig: autoDenyConfig,
				timeoutMs: 30_000,
				...(first ? { model: resolveModelSpec(ctx, first, "judge") ?? ctx.model } : {}),
			}).then((r) => r.content.map((c) => c.text).join("\n"));
		},
	};
	engine.suppressIfAllowed = (exemplar: string) =>
		evaluatePermission(
			"bash",
			exemplar,
			getCurrentProfile(),
			storage.getAllRules(),
			undefined,
			getModeAliases(),
		).action === "allow";
	engine.hooks = {
		onProposalQueued: () => updateInferredBadge(ctx),
		openReviewPopup: () => {
			// Fire-and-forget: owns input while up, Esc defers, never gates.
			import("./inferred-popup-pi.ts")
				.then((m) => m.openInferredReview(ctx, engine, { modes: [getCurrentProfile()], onQueueChange: () => updateInferredBadge(ctx) }))
				.catch(() => {});
		},
	};
	return engine;
}

/** Deliver an auto/ruleset denial to the session model: a display:false nudge
 *  that survives aborts, plus (when visible) a display:true transcript entry
 *  for abort paths where the harness swallows the block reason. */
function sendDenial(text: string, mode: "hidden" | "visible"): void {
  pi.sendMessage({
    customType: "safetynet:denial",
    content: text,
    display: mode === "visible",
  });
}
let storage: PermissionStorage;
let inferredEngine: InferredEngine | undefined;

/** Per-scope deny-strike counter for the main session (all ruleset/mode/
 *  headless/hazardous denials share it). Resets on agent_end. */
const hazardousDenyState: HazardousDenyState = { count: 0 };

/** Loaded prompt keybindings (denyContinue/denyAbort). Initialized at extension init. */
let promptKeybindings: PromptKeybindings = { denyAbort: "escape" };

/** Loaded auto-deny behaviour (continue/reason). Initialized at extension init. */
let autoDenyConfig: AutoDenyConfig = { continue: false };

/** Current model display string (provider/model-id), updated via model_select events. */
let currentModelDisplay: string = "";
/** Current model id (without provider), for the custom footer. */
let currentModelId: string = "";
/** Current model provider id, for the custom footer's "(provider)" prefix. */
let currentModelProvider: string = "";
/** Whether the current model supports extended thinking. */
let currentModelSupportsReasoning: boolean = false;
/** Current thinking level, updated via thinking_level_select events. */
let currentThinkingLevel: string = "off";

/** Cumulative subagent usage for the current turn. Never cleared. */
let subagentUsage: SubagentUsage = { ...ZERO_USAGE };

const SUBAGENT_USAGE_TYPE = "safetynet:subagent-usage";

/** Update the inferred-proposals badge widget (P2, never takes focus). */
function updateInferredBadge(ctx: ExtensionContext): void {
	const n = inferredEngine?.listProposals().length ?? 0;
	if (n > 0) {
		ctx.ui.setWidget(
			"safetynet-inferred",
			[`${n} inferred-rule proposal${n === 1 ? "" : "s"} waiting — /safetynet:inferred to review`],
			{ placement: "belowEditor" },
		);
	} else {
		ctx.ui.setWidget("safetynet-inferred", undefined);
	}
}

function persistSubagentUsage(): void {
	pi.appendEntry(SUBAGENT_USAGE_TYPE, { ...subagentUsage });
}

function restoreSubagentUsage(ctx: ExtensionContext): void {
	const entry = getLatestCustomEntry<SubagentUsage>(ctx, SUBAGENT_USAGE_TYPE);
	if (entry?.data) subagentUsage = { ...ZERO_USAGE, ...entry.data };
}

/** Update the subagent cost status indicator (same mechanism as plan/build mode). */
function refreshSubagentStatus(ctx: ExtensionContext) {
	const formatted = formatSubagentUsage(subagentUsage);
	if (formatted.length > 0) {
		// Key order is defined in footer.ts SAFETYNET_STATUS_KEYS: the mode label
		// renders first on our dedicated footer line, subagent cost second.
		ctx.ui.setStatus("\x00", ctx.ui.theme.fg("dim", `subagents +${formatted}`));
	}
}

/** Extension directory — resolved at module load via import.meta.url */
const extDir = dirname(fileURLToPath(import.meta.url));

/** Directory for plan files */
const plansDir = join(extDir, "plans");

/** Get the plan file path for a given session ID */
function getPlanFilePath(sessionId: string): string {
  return join(plansDir, `${sessionId}.md`);
}


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




/** Whether to trust file paths outside the project root (skip external-path approval).
 *  Opt-in via the global config key OR the `--trust-external-paths` CLI flag. */
function trustExternalActive(): boolean {
  return loadTrustExternalPaths() || pi.getFlag("trust-external-paths") === true;
}

async function handleToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: boolean; reason: string } | undefined> {
  try {
    const profile = getCurrentProfile();
    const modeAliases = getModeAliases();

    const cwd = process.cwd();
    const trustExternal = trustExternalActive();

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      const rules = storage.getAllRules();
      const check = checkBashPermission(command, profile, rules, cwd, trustExternal, modeAliases, inferredEngine?.rulesForProfile(profile, modeAliases));

      if (check.action === "deny") {
        // Per-rule reason wins over configured auto-deny reason; default
        // banner is the fallback. `continue: true` keeps the model's turn.
        const detail = check.reason
          ?? autoDenyConfig.reason
          ?? `Denied by ruleset: ${(check.unapproved ?? []).join(", ")}`;
        ctx.ui.notify(`Command denied: ${command} (${detail})`, "error");
        return resolveDeny({
          permission: "bash",
          target: command,
          reason: detail,
          autoDeny: autoDenyConfig,
          displayCtx: ctx,
          sendDenial,
          onDenied: undefined,
          state: hazardousDenyState,
          source: check.modeDenied ? "mode" : "ruleset",
          hazardous: check.hazardous ?? false,
        });
      }

      return resolvePermission(ctx, {
        permission: "bash",
        target: command,
        check,
        recheck: () => checkBashPermission(command, profile, storage.getAllRules(), cwd, trustExternal, modeAliases, inferredEngine?.rulesForProfile(profile, modeAliases)),
        cwd,
      });
    }

    if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
      const filePath = (event.input.path as string) ?? cwd;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "read",
        target: filePath,
        check: checkFileTarget(filePath, "read", profile, rules, cwd, trustExternal, modeAliases),
        recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternal, modeAliases),
        cwd,
      });
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      if (isReadOnly(profile)) {
        const { write: writeMode } = paradigmModes();
        const writeCmd = writeMode === "rw" ? "/safetynet:rw" : "/safetynet:build";
        const label = profile === "ro" ? "Read-only mode" : "Plan mode";
        const filePath = event.input.path as string;
        return strikeDeny({
          permission: "edit",
          target: filePath,
          reason: `${label}: ${event.toolName} is disabled. The user must switch to ${writeMode} mode with ${writeCmd} before implementation.`,
          source: "mode",
          autoDeny: autoDenyConfig,
          displayCtx: ctx,
          sendDenial,
          onDenied: undefined,
          state: hazardousDenyState,
        });
      }
      const filePath = event.input.path as string;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "edit",
        target: filePath,
        check: checkFileTarget(filePath, "edit", profile, rules, cwd, trustExternal, modeAliases),
        recheck: () => checkFileTarget(filePath, "edit", profile, storage.getAllRules(), cwd, trustExternal, modeAliases),
        cwd,
      });
    }

    if (event.toolName === "read") {
      const filePath = event.input.path as string;
      // Auto-approve reads on the plan file (model may read its own plan)
      const planPath = getPlanFilePath(ctx.sessionManager.getSessionId());
      if (filePath === planPath) return undefined;
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "read",
        target: filePath,
        check: checkFileTarget(filePath, "read", profile, rules, cwd, trustExternal, modeAliases),
        recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternal, modeAliases),
        cwd,
      });
    }

    const knownTools = new Set(["bash", "read", "edit", "write", "grep", "find", "ls", "planWrite", "planEdit", "planPresent", ...(loadSubagentsConfig())]);
    if (!knownTools.has(event.toolName) && isReadOnly(profile)) {
      const rules = storage.getAllRules();
      return resolvePermission(ctx, {
        permission: "bash",
        target: `tool:${event.toolName}`,
        check: checkToolPermission(event.toolName, profile, rules, modeAliases),
        recheck: () => checkToolPermission(event.toolName, profile, storage.getAllRules(), modeAliases),
        cwd,
      });
    }
  } catch (err) {
    ctx.ui.notify(`Permission check error: ${err}`, "warning");
    return undefined;
  }
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
    return new Text("", 0, 0);
  }
  return buildPlanComponent(theme, markdown);
}

/** Render subagent tool call title bar with model and thinking level info. */
function renderSubagentCall(
  label: string,
  args: { prompt: string; model?: string },
  theme: Theme,
  context: any,
) {
  const text = (context.lastComponent as any) ?? new Text("", 0, 0);
  let content = theme.fg("toolTitle", theme.bold(label));
  const modelDisplay = args.model ?? currentModelDisplay;
  if (modelDisplay) {
    content += theme.fg("muted", ` — ${modelDisplay}`);
  }
  if (currentModelSupportsReasoning) {
    content += theme.fg("muted", ` • ${currentThinkingLevel}`);
  }
  text.setText(content);
  return text;
}

/** Render subagent tool results with live activity feed during execution. */
function renderSubagentResult(
  result: { content: { type: string; text?: string }[]; details: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: any,
): any {
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
  if (!text) return new Text("(no output)", 0, 0);

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

function buildAnswerComponent(theme: Theme, content: string): Container {
  const container = new Container();

  const md = new Markdown(content, 1, 0, getMarkdownTheme());
  container.addChild(md);

  const footer = new Text(theme.fg("muted", "  ↵ Reply with feedback"), 0, 1);

  const outer = new Container();
  outer.addChild(container);
  outer.addChild(footer);
  return outer;
}

function renderAnswerResult(result: { content: { type: string; text?: string }[]; details: unknown }, _options: unknown, theme: Theme) {
  const message = (result.details as { message?: unknown } | undefined)?.message;
  if (typeof message !== "string") {
    return new Text("", 0, 0);
  }
  return buildAnswerComponent(theme, message);
}

function registerAnswerTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "answer",
    label: "Answer",
    description: "Provide an answer to the user's question and end the turn. Use when the user asks for clarification, a question, or something that doesn't require modifying files or the plan.",
    parameters: Type.Object({
      message: Type.String({ description: "The answer to display to the user (markdown)" }),
    }),
    renderResult: renderAnswerResult,
    ...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: params.message }],
        details: { message: params.message },
        terminate: true as const,
      };
    },
  });
}

function switchToProfile(ctx: ExtensionContext, profile: ProfileName): void {
  const target = normalizeProfile(profile);
  const current = getCurrentProfile();
  if (current === target) {
    ctx.ui.notify(`Already in ${target} mode`, "info");
    return;
  }
  setCurrentProfile(target);
  persistProfile(pi);
  // One durable mode message per switch — persisted, not ephemeral.
  // display: false — the model needs the reminder; the user sees the toast.
  pi.sendMessage({
    customType: MODE_REMINDER_CUSTOM_TYPE,
    content: getModeSwitchMessage(target),
    display: false,
  });
  ctx.ui.notify(`Switched from ${current} to ${target} mode`, "info");
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

  ctx.ui.setWidget("plan", (_tui, theme) => buildPlanComponent(theme, formatPlanForDisplay(content)));
}
function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("safetynet:auto", {
    description: "Toggle auto-approve mode",
    handler: async (_args, ctx) => {
      const r = toggleAutoEnabled(pi);
      if (r.blockedReason) ctx.ui.notify(`Auto-approve unavailable: ${r.blockedReason}`, "warning");
      else ctx.ui.notify(`Auto-approve ${r.enabled ? "enabled" : "disabled"}`, "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("safetynet:inferred", {
    description: "Review pending inferred-rule proposals",
    handler: async (_args, ctx) => {
      if (!inferredEngine) {
        ctx.ui.notify("safetynet: no session — nothing to review", "warning");
        return;
      }
      const { openInferredReview } = await import("./inferred-popup-pi.ts");
      const result = await openInferredReview(ctx, inferredEngine, {
        modes: [getCurrentProfile()],
        onQueueChange: () => updateInferredBadge(ctx),
      });
      if (result === "empty") ctx.ui.notify("safetynet: no pending inferred-rule proposals", "info");
      else if (result === "busy") ctx.ui.notify("safetynet: another prompt is open — review when it closes", "warning");
      updateInferredBadge(ctx);
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

  pi.registerCommand("safetynet:ro", {
    description: "Switch to read-only mode",
    handler: async (_args, ctx) => switchToProfile(ctx, "ro"),
  });

  pi.registerCommand("safetynet:rw", {
    description: "Switch to read-write mode",
    handler: async (_args, ctx) => switchToProfile(ctx, "rw"),
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

function registerSubagentTools(pi: ExtensionAPI, subagents: string[]) {

	// subagent_explore is also available in plan mode
	// subagent_build is build-only

	function resolveModel(modelSpec: string | undefined, ctx: ExtensionContext) {
		if (!modelSpec) return ctx.model;
		const slashIdx = modelSpec.indexOf("/");
		if (slashIdx < 1) return ctx.model;
		const provider = modelSpec.slice(0, slashIdx);
		const modelId = modelSpec.slice(slashIdx + 1);
		return ctx.modelRegistry.find(provider, modelId) ?? ctx.model;
	}

	if (subagents.includes("subagent_explore")) pi.registerTool({
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
		renderCall: (args, theme, context) => renderSubagentCall("Subagent Explore", args, theme, context),
		...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runSubagent({
				taskType: "explore",
				prompt: params.prompt,
				parentCtx: ctx,
				parentStorage: storage,
				initialRules: storage.getAllRules(),
				signal,
				onUpdate,
				cwd: ctx.cwd,
				model: resolveModel(params.model, ctx),
				thinkingLevel: pi.getThinkingLevel(),
				trustExternalPaths: trustExternalActive(),
				promptKeybindings,
				autoDenyConfig,
				paradigm: getParadigm(),
				modeAliases: getModeAliases(),
			});
			if (result.details && typeof result.details === "object" && "usage" in result.details) {
				subagentUsage = addUsage(subagentUsage, result.details.usage as SubagentUsage);
				refreshSubagentStatus(ctx);
			}
			return result;
		},
	});

	if (subagents.includes("subagent_build")) pi.registerTool({
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
		renderCall: (args, theme, context) => renderSubagentCall("Subagent Build", args, theme, context),
		...(typeof process !== 'undefined' && { renderShell: 'self' as const }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runSubagent({
				taskType: "build",
				prompt: params.prompt,
				parentCtx: ctx,
				parentStorage: storage,
				initialRules: storage.getAllRules(),
				signal,
				onUpdate,
				cwd: ctx.cwd,
				model: resolveModel(params.model, ctx),
				thinkingLevel: pi.getThinkingLevel(),
				trustExternalPaths: trustExternalActive(),
				promptKeybindings,
				autoDenyConfig,
				paradigm: getParadigm(),
				modeAliases: getModeAliases(),
			});
			if (result.details && typeof result.details === "object" && "usage" in result.details) {
				subagentUsage = addUsage(subagentUsage, result.details.usage as SubagentUsage);
				refreshSubagentStatus(ctx);
			}
			return result;
		},
	});
}

function registerShortcuts(pi: ExtensionAPI) {
  pi.registerShortcut(loadToggleModeKey() as "ctrl+\\", {
    description: "Toggle between read-only and read-write mode",
    handler: async (ctx) => {
      const { read, write } = paradigmModes();
      const next: ProfileName = getCurrentProfile() === read ? write : read;
      switchToProfile(ctx, next);
    },
  });

  pi.registerShortcut("ctrl+shift+\\", {
    description: "Toggle LLM auto-approval of low-risk actions",
    handler: async (ctx) => {
      const r = toggleAutoEnabled(pi);
      if (r.blockedReason) ctx.ui.notify(`safetynet auto-approve unavailable: ${r.blockedReason}`, "warning");
      else ctx.ui.notify(`safetynet auto-approve: ${r.enabled ? "ON" : "OFF"}`, "info");
      updateStatus(ctx);
    },
  });
}

function updateStatus(ctx: ExtensionContext) {
  const profile = getCurrentProfile();
  const label = isAutoEnabled() ? `${profile} auto` : profile;
  ctx.ui.setStatus("safetynet", label);
}

/**
 * Install the custom footer: pwd/stats/model lines render like the built-in
 * footer, but OUR status entries (mode label + subagent usage) get a dedicated
 * line of their own, so other extensions' statuses can never crowd them out or
 * truncate the read-only indicator away.
 */
function installFooter(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubBranch,
      invalidate() {},
      render(width: number): string[] {
        const model = ctx.model;
        return renderCustomFooter({
          width,
          theme,
          entries: ctx.sessionManager.getEntries(),
          contextUsage: ctx.getContextUsage(),
          modelId: currentModelId || model?.id || "no-model",
          modelProvider: currentModelProvider || model?.provider || undefined,
          modelSupportsReasoning: currentModelSupportsReasoning,
          thinkingLevel: currentThinkingLevel,
          providerCount: footerData.getAvailableProviderCount(),
          usingSubscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false,
          cwd: ctx.sessionManager.getCwd(),
          home: process.env.HOME || process.env.USERPROFILE,
          gitBranch: footerData.getGitBranch(),
          sessionName: ctx.sessionManager.getSessionName(),
          autoCompact: true,
          extensionStatuses: footerData.getExtensionStatuses(),
        });
      },
    };
  });
}

let pi: ExtensionAPI;

interface RestoreOpts {
  init?: boolean;
  replaceSession?: boolean;
  notify?: boolean;
}

async function restoreSessionState(ctx: ExtensionContext, opts?: RestoreOpts): Promise<void> {
  if (opts?.init) await storage.init();
  restoreProfile(ctx);
  restoreSubagentUsage(ctx);
  restoreAutoEnabled(ctx);

  const { rules: sessionRules, skippedCount } = reconstructSessionRules(ctx, process.cwd());
  if (opts?.replaceSession) {
    const s = storage.session;
    s.clear();
    if (sessionRules.length > 0) s.addRules(sessionRules);
  } else {
    if (sessionRules.length > 0) storage.addSessionRules(sessionRules);
  }

  if (skippedCount > 0 && ctx.hasUI) {
    ctx.ui.notify(`${skippedCount} session rule group(s) skipped — cwd changed since they were created.`, "warning");
  }

  updateStatus(ctx);

  if (opts?.notify && ctx.hasUI) {
    ctx.ui.notify(`safetynet loaded in ${getCurrentProfile()} mode`, "info");
  }
}

export default function safetynetExtension(api: ExtensionAPI) {
  pi = api;

  storage = new PermissionStorage(process.cwd());

  // Load configurable prompt keybindings + auto-deny behaviour from global config.
  promptKeybindings = loadKeybindings();
  autoDenyConfig = loadAutoDeny();

  registerPlanTools(pi);
  // registerAnswerTool(pi); // temporarily disabled
  // questionnaire(pi); // disabled
	const subagents = loadSubagentsConfig();
	if (subagents.length > 0) registerSubagentTools(pi, subagents);
  registerCommands(pi);
  registerShortcuts(pi);

  pi.registerFlag("build", {
    description: "Start in build mode (full access)",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("paradigm", {
    description: "Which mode pair to use: plan-build or ro-rw",
    type: "string",
  });

  pi.registerFlag("trust-external-paths", {
    description: "Trust file paths outside the project root (skip external-path approval)",
    type: "boolean",
    default: false,
  });


  pi.registerFlag("allow", {
    description: "Add temporary allow rules (comma-separated, format: \"permission: pattern\")",
    type: "string",
  });

  pi.on("model_select", async (event) => {
    currentModelDisplay = `${event.model.provider}/${event.model.id}`;
    currentModelId = event.model.id;
    currentModelProvider = event.model.provider;
    currentModelSupportsReasoning = event.model.reasoning ?? false;
  });

  pi.on("thinking_level_select", async (event) => {
    currentThinkingLevel = event.level;
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx.model) {
      currentModelDisplay = `${ctx.model.provider}/${ctx.model.id}`;
      currentModelId = ctx.model.id;
      currentModelProvider = ctx.model.provider;
      currentModelSupportsReasoning = ctx.model.reasoning ?? false;
    }
    currentThinkingLevel = pi.getThinkingLevel();
    installFooter(ctx);
    inferredEngine = new InferredEngine(ctx.cwd);
    loadLearnedBoundaries();
    uiArbiter.reset(); // no stale surface may block a fresh session's prompts

    // Apply the paradigm FIRST, before profile restore/brand-new default above,
    // so restoreProfile and the default profile normalize against the correct
    // paradigm. Config default, overridden by the --paradigm flag.
    const flagParadigm = pi.getFlag("paradigm");
    if (flagParadigm === "plan-build" || flagParadigm === "ro-rw") {
      setParadigm(flagParadigm);
    } else {
      setParadigm(loadParadigm());
    }

    await restoreSessionState(ctx, { init: true, notify: true, replaceSession: event.reason === "fork" });

    // Brand-new sessions always start in the configured default profile (plan by default).
    // Forks/resume/reload inherit the persisted profile via restoreSessionState above.
    // `pi --session`/`--resume`/`--continue` emit reason "startup" just like a plain `pi` launch,
    // so we use getEntries() to tell a true brand-new session (empty on disk) from a resume.
    const isBrandNew =
      event.reason === "new" ||
      (event.reason === "startup" && ctx.sessionManager.getEntries().length === 0);
    if (isBrandNew) {
      const defaultProfile = normalizeProfile(loadDefaultProfile() ?? paradigmModes().read);
      setCurrentProfile(defaultProfile);
      resetAutoEnabledForNewSession();
      storage.session.clear();
      persistProfile(pi);
      updateStatus(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`New session: starting in ${defaultProfile} mode`, "info");
      }
    } else if (event.reason === "startup") {
      // Resumed session (pi --session/--resume/--continue): keep the profile restored by
      // restoreSessionState rather than clobbering it with the default.
      updateStatus(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(`Resumed session in ${getCurrentProfile()} mode`, "info");
      }
    }

    // Ensure plans directory exists
    mkdirSync(plansDir, { recursive: true });

    // Headless: no UI for permission prompts or mode switching, so default to
    // the active paradigm's write mode.
    if (!ctx.hasUI) {
      setCurrentProfile(paradigmModes().write);
      persistProfile(pi);
      updateStatus(ctx);
    }

    if (pi.getFlag("build") === true) {
      setCurrentProfile(paradigmModes().write);
      persistProfile(pi);
      updateStatus(ctx);
    }
    const allowFlag = pi.getFlag("allow");
    if (typeof allowFlag === "string" && allowFlag.trim()) {
      const rules = parseAllowFlag(allowFlag);
      if (rules.length > 0) {
        storage.addFlagRules(rules);
      }
    }

    // Session-start reminder (step 4): one durable message announcing the
    // opening mode. Sent after all mode resolution (default, --build flag,
    // headless default) so it matches the actual mode.
    if (isBrandNew) {
      pi.sendMessage({
        customType: MODE_REMINDER_CUSTOM_TYPE,
        content: getSessionModeMessage(getCurrentProfile()),
        display: false,
      });
    }
  });

  pi.on("tool_call", handleToolCall);

  pi.on("agent_end", async (_event, ctx) => {
    storage.temp.clearTurnRules();
    persistSubagentUsage();
    refreshSubagentStatus(ctx);
    reviewBumpTurnToken();
    reviewResetDenies();
    hazardousDenyState.count = 0;
    if (inferredEngine) updateInferredBadge(ctx);
  });

  // Mode messaging: per-turn mode-specific stanza in the system prompt.
  // The active-mode stanza is appended on every agent start (matching the
  // current profile), so after a mode switch the next turn's prompt already
  // reflects the new mode; durable reminders carry the switch itself.
  pi.on("before_agent_start", async (event, ctx) => {
    // Clear stale plan widget from a previous turn
    ctx.ui.setWidget("plan", undefined);
    return { systemPrompt: `${event.systemPrompt}\n\n${getModeSystemPrompt(getCurrentProfile())}` };
  });

  // Compaction purges history; re-append the current-mode reminder
  // unconditionally so the mode survives the purge.
  pi.on("session_compact", async () => {
    pi.sendMessage({
      customType: MODE_REMINDER_CUSTOM_TYPE,
      content: getSessionModeMessage(getCurrentProfile()),
      display: false,
    });
  });



  pi.on("session_tree", async (_event, ctx) => {
    await restoreSessionState(ctx, { replaceSession: true });
    // Counters are session evidence — a tree switch is a new context.
    inferredEngine = new InferredEngine(ctx.cwd);
    loadLearnedBoundaries();
    uiArbiter.reset();
    updateInferredBadge(ctx);
  });
}
