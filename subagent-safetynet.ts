/**
 * Subagent Safetynet Extension — permission enforcement for subagents.
 *
 * Two modes:
 * - explore: simple allowlist (read/grep/find/ls). No "ask" ever.
 *   Defense-in-depth only — the primary enforcement is the tool list.
 * - build: full permission system with bridging to the parent's TUI, sharing
 *   the parent's single PermissionStorage so an approval granted anywhere
 *   (parent or child) applies everywhere; turn-scoped rules expire together at
 *   the root session's turn end.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProfileName, Paradigm, ModeAliases, AutoDenyConfig } from "./core/types.ts";
import type { PermissionPromptOptions } from "./prompts.ts";
import type { PromptKeybindings } from "./core/types.ts";
import { showPermissionPrompt } from "./prompts.ts";
import { capReportBody, capReportSummary } from "./core/report.ts";
import {
  PermissionStorage,
} from "./core/permissions/index.ts";
import { isHazardousFile } from "./core/bash-parser.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./core/check.ts";
import { normalizePathForMatching, toRecursiveGlob, normalizeToolPath } from "./core/project.ts";
import { getCurrentProfile, isReadOnly } from "./core/profiles.ts";
import { resolvePermission as resolvePermissionShared, makeTempRule, resolveDeny, type HazardousDenyState } from "./pipeline.ts";

/** Per-segment reporting bookkeeping shared with the job runner. The runner
 *  resets these before each work segment and reads `reported` when the segment
 *  settles to distinguish an explicit "nothing to report" from silence. */
export interface SegmentState {
	reported: boolean;
	nudged: boolean;
}

/** A child→parent report as submitted by the `report_to_parent` tool. */
export interface ReportInput {
	summary: string;
	body?: string;
	urgent?: boolean;
}

/** Reporting wiring injected by the persistent job runner. `send` must target
 *  the PARENT session (index.ts owns that callback); the child extension's own
 *  `pi.sendMessage` only ever reaches the child. */
export interface ReportingOptions {
	send: (report: ReportInput) => void;
	segment: SegmentState;
}

export interface SubagentSafetynetOpts {
	taskType: "explore" | "build";
	cwd: string;
	/** Build-only: parent context for bridging permission prompts to parent TUI */
	parentCtx?: ExtensionContext;
	/** Build-only: the session tree's shared permission pool (the parent's). */
	parentStorage?: PermissionStorage;
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
	/** Skip the generic explore/build role context message. Set for specialized
	 *  subagents (permission reviewer, inferred-rule judge) that run read-only
	 *  tools under their own system prompt — the generic "You are a read-only
	 *  explore subagent" text otherwise leaks the harness identity into the
	 *  model's self-assessment. */
	omitContextMessage?: boolean;
	/** Collaborative reporting wiring. When present, the `report_to_parent` tool
	 *  and the one-shot settle guard are registered. Internal subagents
	 *  (reviewer/judge) omit this. */
	reporting?: ReportingOptions;
}

const SUBAGENT_EPHEMERAL_CUSTOM_TYPE = "safetynet:subagent-ephemeral";

/** Name of the child→parent report tool. */
export const REPORT_TOOL_NAME = "report_to_parent";
/** customType for the one-shot settle-guard reminder injected into the child. */
const REPORT_REMINDER_CUSTOM_TYPE = "safetynet:report-reminder";

const EXPLORE_TOOL_NAMES = ["read", "grep", "find", "ls"];
const BUILD_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ─── Explore mode ──────────────────────────────────────────────────────────

function createExploreSafetynet(opts: SubagentSafetynetOpts): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const allowedTools = new Set([...EXPLORE_TOOL_NAMES, ...(opts.reporting ? [REPORT_TOOL_NAME] : [])]);

		// Force the correct active tool set. bindExtensions resets tools to defaults
		// (read, bash, edit, write), so the subagent LLM would see edit/write/bash
		// instead of read-only tools unless we fix it here.
		pi.on("session_start", async () => {
			pi.setActiveTools(activeToolNames("explore", opts.reporting !== undefined));
		});

		registerCollaboration(pi, opts.reporting);

		// Defense-in-depth: block any tool outside the allowlist, and enforce the
		// same sensitive-file block the main session applies to file reads. Without
		// it a read-only child is a secret-exfiltration path the parent itself
		// would deny (`read .env`).
		pi.on("tool_call", async (event: ToolCallEvent, _ctx: ExtensionContext) => {
			if (!allowedTools.has(event.toolName)) {
				return { block: true, reason: `Tool '${event.toolName}' is not available in explore mode` };
			}
			const rawPath = (event.input as Record<string, unknown>).path;
			if (typeof rawPath === "string" && isHazardousFile(normalizeToolPath(rawPath))) {
				return {
					block: true,
					reason: "Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.",
				};
			}
			return undefined;
		});

		// Specialized subagents (permission reviewer, inferred-rule judge) carry
		// their own system prompt and must NOT receive the generic explore
		// identity: the reviewer otherwise reasons about "you are a read-only
		// explore subagent" as though it described the session under review.
		if (!opts.omitContextMessage) pi.on("context", async (event) => {
			const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
				role: "custom",
				customType: SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
				content: getSubagentContextMessage("explore", opts.reporting !== undefined),
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
		const { cwd, onPermissionDenied, trustExternalPaths = false, promptKeybindings = { denyAbort: "escape" }, autoDenyConfig = { continue: false }, paradigm = "plan-build", modeAliases = {} } = opts;

	return (pi: ExtensionAPI) => {
		/** The session tree's single permission pool: a child shares the parent's
		 *  storage, so an approval granted anywhere (parent or child) applies
		 *  everywhere. Turn-scoped rules expire together at the root's turn end. */
		const subagentStorage: PermissionStorage = parentStorage;
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

		pi.on("session_start", async () => {
			// The shared pool is already created and initialized by the parent; just
			// restore the active tool set (bindExtensions resets it to the defaults).
			pi.setActiveTools(activeToolNames("build", opts.reporting !== undefined));
		});

		registerCollaboration(pi, opts.reporting);

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
							hazardous: check.hazardous ?? false,
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
					const filePath = normalizeToolPath((event.input.path as string) ?? cwd);
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "read",
						target: filePath,
						check: checkFileTarget(filePath, "read", profile, rules, cwd, trustExternalPaths, modeAliases),
						recheck: () => checkFileTarget(filePath, "read", profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}

				if (event.toolName === "edit" || event.toolName === "write") {
					const filePath = normalizeToolPath(event.input.path as string);
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "edit",
						target: filePath,
						check: checkFileTarget(filePath, "edit", profile, rules, cwd, trustExternalPaths, modeAliases),
						recheck: () => checkFileTarget(filePath, "edit", profile, subagentStorage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					});
				}

				if (event.toolName === "read") {
					const filePath = normalizeToolPath(event.input.path as string);
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
				// Fail closed: a check that could not complete must not allow the call.
				return { block: true, reason: `Permission check failed (${err}); blocked to be safe` };
			}
		});

		pi.on("agent_end", async () => {
			// Turn-scoped rules live in the shared pool and expire with the root
			// session's turn. A child's agent_end fires on every segment completion
			// and must not clear approvals the parent may still be using.
			hazardousDenyState.count = 0;
		});

		if (!opts.omitContextMessage) pi.on("context", async (event) => {
			const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
				role: "custom",
				customType: SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
				content: getSubagentContextMessage("build", opts.reporting !== undefined),
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
					cwd,
					allowModes: [writeProfile],
					currentReviewProfile: () => (isReadOnly(getCurrentProfile()) ? "ro" : "rw"),
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

// ─── Collaboration (report tool + settle guard) ────────────────────────────

/** Active tool names for a subagent, plus the report tool for collaborative ones. */
function activeToolNames(taskType: "explore" | "build", reporting: boolean): string[] {
	const base = taskType === "explore" ? EXPLORE_TOOL_NAMES : BUILD_TOOL_NAMES;
	return reporting ? [...base, REPORT_TOOL_NAME] : [...base];
}

/**
 * Register the child→parent mailbox surface for collaborative subagents:
 * the `report_to_parent` tool and the one-shot settle guard.
 *
 * The guard exists because silence alone cannot distinguish "finished, nothing
 * to say" from "stopped without reporting". It forces at most ONE extra
 * continuation per segment; `segment.nudged` makes a second settle silent, so
 * a child that ignores the nudge can never loop.
 */
function registerCollaboration(pi: ExtensionAPI, reporting: ReportingOptions | undefined): void {
	if (!reporting) return;

	pi.registerTool({
		name: REPORT_TOOL_NAME,
		label: "Report to Parent",
		description: "Send a status report to the parent agent. Use this to surface findings, progress, blockers, or an explicit 'nothing to report' before you finish.",
		promptSnippet: "Report status to the parent agent",
		promptGuidelines: [
			"Call report_to_parent before you finish each work segment, even when there is nothing to report (a short summary is valid).",
			"Call report_to_parent whenever the parent should know something: findings, blockers, or completion. Set urgent=true only when the parent must be woken immediately.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "One-line summary the parent will see" }),
			body: Type.Optional(Type.String({ description: "Optional detail; capped with an explicit truncation marker" })),
			urgent: Type.Optional(Type.Boolean({ description: "Wake the parent immediately instead of waiting for the next idle" })),
		}),
		async execute(_toolCallId, params) {
			reporting.send({
				summary: capReportSummary(params.summary),
				...(params.body !== undefined ? { body: capReportBody(params.body) } : {}),
				...(params.urgent !== undefined ? { urgent: params.urgent } : {}),
			});
			reporting.segment.reported = true;
			return {
				content: [{ type: "text", text: "Report delivered to parent." }],
				details: {},
			};
		},
	});

	pi.on("agent_before_settle", async () => {
		if (reporting.segment.reported || reporting.segment.nudged) return undefined;
		reporting.segment.nudged = true;
		return {
			entries: [{
				type: "custom_message" as const,
				customType: REPORT_REMINDER_CUSTOM_TYPE,
				content: "Before finishing, call report_to_parent to tell the parent what happened or that there is nothing to report.",
				display: false,
			}],
			continue: true,
		};
	});
}

// ─── Context messages ─────────────────────────────────────────────────────

function getSubagentContextMessage(taskType: "explore" | "build", reporting = false): string {
	const reportHint = reporting
		? `\n\nYou can communicate with the parent agent using report_to_parent. Call it whenever the parent should know something, and always before you finish a work segment — a short "nothing to report" is valid.`
		: "";
	if (taskType === "explore") {
		return `[SAFETYNET SUBAGENT EXPLORE MODE]
You are a read-only explore subagent. You can read files and search the codebase.

You CANNOT modify files, run commands, or ask questions.
Focus on completing the task you were given. Report your findings concisely.${reportHint}`;
	}

	return `[SAFETYNET SUBAGENT BUILD MODE]
You are a subagent running in build mode. Permission prompts will be shown to the parent session's user for approval.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

Focus on completing the task you were given. Be concise in your output.${reportHint}`;
}
