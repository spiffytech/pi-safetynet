/**
 * Subagent Safetynet Extension — permission enforcement for subagents.
 *
 * Two modes:
 * - explore: simple allowlist (read/grep/find/ls). No "ask" ever.
 *   Defense-in-depth only — the primary enforcement is the tool list.
 * - build: full permission system with bridging to parent's TUI.
 *   Rules approved during the subagent session propagate to the parent.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Rule, Ruleset, TempRule, ProfileName, Paradigm, ModeAliases, AutoDenyConfig } from "./core/types.ts";
import type { PermissionPromptOptions } from "./prompts.ts";
import type { PromptKeybindings } from "./core/types.ts";
import { showPermissionPrompt } from "./prompts.ts";
import {
  PermissionStorage,
} from "./core/permissions/index.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./core/check.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./core/project.ts";
import { resolvePermission as resolvePermissionShared, makeTempRule, resolveDeny, type HazardousDenyState } from "./pipeline.ts";

export interface SubagentSafetynetOpts {
	taskType: "explore" | "build";
	cwd: string;
	/** Build-only: parent context for bridging permission prompts to parent TUI */
	parentCtx?: ExtensionContext;
	/** Build-only: parent's permission storage for rule propagation */
	parentStorage?: PermissionStorage;
	/** Build-only: snapshot of parent's rules to seed subagent storage */
	initialRules?: Ruleset;
	/** Build-only: callback to abort the entire subagent session on permission rejection */
	onPermissionDenied?: () => void;
	/** Active paradigm, so build subagents use the matching write-mode name. */
	paradigm?: Paradigm;
	/** Mode-name aliasing for rule matching (plan→ro / build→rw bijection). */
	modeAliases?: ModeAliases;
	/** Inherited from parent: trust file paths outside the project root */
	trustExternalPaths?: boolean;
	/** Inherited from parent: prompt keybindings for the bridged permission prompt. */
	promptKeybindings?: PromptKeybindings;
	/** Inherited from parent: auto-deny behaviour for rule-denies. */
	autoDenyConfig?: AutoDenyConfig;
}

const SUBAGENT_EPHEMERAL_CUSTOM_TYPE = "safetynet:subagent-ephemeral";

const EXPLORE_TOOL_NAMES = ["read", "grep", "find", "ls"];
const BUILD_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ─── Explore mode ──────────────────────────────────────────────────────────

function createExploreSafetynet(_opts: SubagentSafetynetOpts): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const allowedTools = new Set(EXPLORE_TOOL_NAMES);

		// Force the correct active tool set. bindExtensions resets tools to defaults
		// (read, bash, edit, write), so the subagent LLM would see edit/write/bash
		// instead of read-only tools unless we fix it here.
		pi.on("session_start", async () => {
			pi.setActiveTools(EXPLORE_TOOL_NAMES);
		});

		// Defense-in-depth: block any tool outside the allowlist
		pi.on("tool_call", async (event: ToolCallEvent, _ctx: ExtensionContext) => {
			if (allowedTools.has(event.toolName)) return undefined;
			return { block: true, reason: `Tool '${event.toolName}' is not available in explore mode` };
		});

		pi.on("context", async (event) => {
			const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
				role: "custom",
				customType: SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
				content: getSubagentContextMessage("explore"),
				display: false,
				timestamp: Date.now(),
			};
			const filtered = event.messages.filter(
				(m) => (m as AgentMessage & { customType?: string }).customType !== SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
			);
			filtered.push(ephemeralMessage);
			return { messages: filtered };
		});
	};
}

// ─── Build mode ────────────────────────────────────────────────────────────

function createBuildSafetynet(opts: SubagentSafetynetOpts): (pi: ExtensionAPI) => void {
	if (!opts.parentCtx || !opts.parentStorage) {
		throw new Error("Build subagent requires parentCtx and parentStorage");
	}
	const parentCtx: ExtensionContext = opts.parentCtx;
	const parentStorage: PermissionStorage = opts.parentStorage;
		const { initialRules, cwd, onPermissionDenied, trustExternalPaths = false, promptKeybindings = { denyAbort: "escape" }, autoDenyConfig = { continue: false }, paradigm = "plan-build", modeAliases = {} } = opts;

	return (pi: ExtensionAPI) => {
		/** Per-scope hazardous-deny counter for this subagent. Fresh per extension
		 *  instance — parallel subagents never share the parent's counter. */
		const hazardousDenyState: HazardousDenyState = { count: 0 };
		const writeProfile: ProfileName = paradigm === "ro-rw" ? "rw" : "build";

		/** Deliver a denial to the subagent's model: display:false nudge plus,
		 *  when visible, a display:true transcript entry for abort paths. */
		function sendDenial(text: string, mode: "hidden" | "visible"): void {
			pi.sendMessage({
				customType: "safetynet:denial",
				content: text,
				display: mode === "visible",
			});
		}
		let subagentStorage: PermissionStorage;

		pi.on("session_start", async (_event, ctx) => {
			subagentStorage = new PermissionStorage(cwd);
			await subagentStorage.init();
			if (initialRules && initialRules.length > 0) {
				subagentStorage.addSessionRules(initialRules);
			}
			// Ensure correct active tool set after bindExtensions reset
			pi.setActiveTools(BUILD_TOOL_NAMES);
		});

		pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
			try {
				const profile: ProfileName = writeProfile;

				if (event.toolName === "bash") {
					const command = event.input.command as string;
					const rules = subagentStorage.getAllRules();
					const check = checkBashPermission(command, profile, rules, cwd, trustExternalPaths, modeAliases);

					if (check.action === "deny") {
						const detail = check.reason ?? `Denied by ruleset: ${(check.unapproved ?? []).join(", ")}`;
						ctx.ui.notify(`Command denied: ${command} (${detail})`, "error");
						return resolveDeny({
							permission: "bash",
							target: command,
							reason: detail,
							autoDeny: autoDenyConfig,
							displayCtx: ctx,
							sendDenial,
							onDenied: onPermissionDenied,
							state: hazardousDenyState,
							source: check.modeDenied ? "mode" : "ruleset",
						});
					}

					return resolvePermission(ctx, {
						permission: "bash",
						target: command,
						check,
						recheck: () => checkBashPermission(command, profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}

				if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
					const filePath = (event.input.path as string) ?? cwd;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "read",
						target: filePath,
						check: checkFileTarget(filePath, "read", profile, rules, cwd, trustExternalPaths, modeAliases),
						recheck: () => checkFileTarget(filePath, "read", profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}

				if (event.toolName === "edit" || event.toolName === "write") {
					const filePath = event.input.path as string;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "edit",
						target: filePath,
						check: checkFileTarget(filePath, "edit", profile, rules, cwd, trustExternalPaths, modeAliases),
						recheck: () => checkFileTarget(filePath, "edit", profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}

				if (event.toolName === "read") {
					const filePath = event.input.path as string;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "read",
						target: filePath,
						check: checkFileTarget(filePath, "read", profile, rules, cwd, trustExternalPaths, modeAliases),
						recheck: () => checkFileTarget(filePath, "read", profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}
			} catch (err) {
				ctx.ui.notify(`Permission check error: ${err}`, "warning");
				return undefined;
			}
		});

		pi.on("agent_end", async () => {
			subagentStorage.temp.clearTurnRules();
			hazardousDenyState.count = 0;
			// Do NOT clear parentStorage temp rules here.
			// The parent's own agent_end handler manages its temp rules.
			// The subagent's agent_end fires on every subagent turn completion,
			// which would incorrectly clear the parent's turn-scoped rules.
		});

		pi.on("context", async (event) => {
			const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
				role: "custom",
				customType: SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
				content: getSubagentContextMessage("build"),
				display: false,
				timestamp: Date.now(),
			};
			const filtered = event.messages.filter(
				(m) => (m as AgentMessage & { customType?: string }).customType !== SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
			);
			filtered.push(ephemeralMessage);
			return { messages: filtered };
		});

		async function resolvePermission(
			ctx: ExtensionContext,
			opts: {
				permission: "bash" | "read" | "edit";
				target: string;
				check: PermissionCheck;
				recheck: () => PermissionCheck;
			},
		): Promise<{ block: boolean; reason: string } | undefined> {
			return resolvePermissionShared(
				{
					displayCtx: parentCtx,
					storage: subagentStorage,
					dualWrite: [parentStorage],
					cwd,
					allowModes: [writeProfile],
					...(onPermissionDenied ? { onDenied: onPermissionDenied } : {}),
					keybindings: promptKeybindings,
					autoDeny: autoDenyConfig,
					hazardousDenyState,
					sendManualApproval: () => {
						pi.sendMessage({
							customType: "safetynet:manual-approval",
							content: "The user manually approved this command by interactive prompt.",
							display: false,
						});
					},
					sendDenial: (text, mode) => {
						pi.sendMessage({
							customType: "safetynet:denial",
							content: text,
							display: mode === "visible",
						});
					},
				},
				opts,
			);
		}
	};
}

// ─── Public export ─────────────────────────────────────────────────────────

export function createSubagentSafetynetExtension(opts: SubagentSafetynetOpts): (pi: ExtensionAPI) => void {
	if (opts.taskType === "explore") {
		return createExploreSafetynet(opts);
	}
	return createBuildSafetynet(opts);
}

// ─── Context messages ─────────────────────────────────────────────────────

function getSubagentContextMessage(taskType: "explore" | "build"): string {
	if (taskType === "explore") {
		return `[SAFETYNET SUBAGENT EXPLORE MODE]
You are a read-only explore subagent. You can read files and search the codebase.

You CANNOT modify files, run commands, or ask questions.
Focus on completing the task you were given. Report your findings concisely.`;
	}

	return `[SAFETYNET SUBAGENT BUILD MODE]
You are a subagent running in build mode. Permission prompts will be shown to the parent session's user for approval.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

Focus on completing the task you were given. Be concise in your output.`;
}
