/**
 * Subagent Safetynet Extension — permission enforcement for subagents.
 *
 * Two modes:
 * - explore: simple allowlist (read/grep/find/ls). No "ask" ever.
 *   Defense-in-depth only — the primary enforcement is the tool list.
 * - build: full permission system with bridging to parent's TUI.
 *   Rules approved during the subagent session propagate to the parent.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Rule, Ruleset, TempRule, ProfileName } from "./types.ts";
import type { PermissionPromptOptions } from "./prompts.ts";
import { showPermissionPrompt } from "./prompts.ts";
import {
	PermissionStorage,
} from "./permissions/index.ts";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "./check.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./project.ts";

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
}

const SUBAGENT_EPHEMERAL_CUSTOM_TYPE = "safetynet:subagent-ephemeral";
const DEFAULT_TIMED_APPROVAL_MINUTES = 15;

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

function makeTempRules(
	opts: {
		permission: "bash" | "read" | "edit";
		patterns: string[];
		expiryType: "time" | "turn";
		minutes?: number;
	},
): TempRule[] {
	const modes: ProfileName[] = ["build"];
	return opts.patterns.map((p) => ({
		rule: {
			permission: opts.permission as Rule["permission"],
			pattern: p,
			action: "allow" as const,
			modes,
		},
		expiry: opts.expiryType === "time"
			? { type: "time" as const, expiresAt: Date.now() + (opts.minutes ?? DEFAULT_TIMED_APPROVAL_MINUTES) * 60_000 }
			: { type: "turn" as const },
	}));
}

function createBuildSafetynet(opts: SubagentSafetynetOpts): (pi: ExtensionAPI) => void {
	if (!opts.parentCtx || !opts.parentStorage) {
		throw new Error("Build subagent requires parentCtx and parentStorage");
	}
	const parentCtx: ExtensionContext = opts.parentCtx;
	const parentStorage: PermissionStorage = opts.parentStorage;
	const { initialRules, cwd, onPermissionDenied } = opts;

	return (pi: ExtensionAPI) => {
		let subagentStorage: PermissionStorage;

		pi.on("session_start", async (_event, ctx) => {
			subagentStorage = new PermissionStorage(pi, cwd);
			await subagentStorage.init(ctx);
			if (initialRules && initialRules.length > 0) {
				subagentStorage.addSessionRules(initialRules);
			}
			// Ensure correct active tool set after bindExtensions reset
			pi.setActiveTools(BUILD_TOOL_NAMES);
		});

		pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
			try {
				const profile: ProfileName = "build";

				if (event.toolName === "bash") {
					const command = event.input.command as string;
					const rules = subagentStorage.getAllRules();
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
						recheck: () => checkBashPermission(command, profile, subagentStorage.getAllRules(), cwd),
					});
				}

				if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
					const filePath = (event.input.path as string) ?? cwd;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "read",
						target: filePath,
						check: checkFileTarget(filePath, "read", profile, rules, cwd),
						recheck: () => checkFileTarget(filePath, "read", profile, subagentStorage.getAllRules(), cwd),
					});
				}

				if (event.toolName === "edit" || event.toolName === "write") {
					const filePath = event.input.path as string;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "edit",
						target: filePath,
						check: checkFileTarget(filePath, "edit", profile, rules, cwd),
						recheck: () => checkFileTarget(filePath, "edit", profile, subagentStorage.getAllRules(), cwd),
					});
				}

				if (event.toolName === "read") {
					const filePath = event.input.path as string;
					const rules = subagentStorage.getAllRules();
					return resolvePermission(ctx, {
						permission: "read",
						target: filePath,
						check: checkFileTarget(filePath, "read", profile, rules, cwd),
						recheck: () => checkFileTarget(filePath, "read", profile, subagentStorage.getAllRules(), cwd),
					});
				}
			} catch (err) {
				ctx.ui.notify(`Permission check error: ${err}`, "warning");
				return undefined;
			}
		});

		pi.on("agent_end", async () => {
			subagentStorage.temp.clearTurnRules();
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
			const { action } = opts.check;

			if (action === "allow") return undefined;

			if (action === "deny") {
				ctx.abort();
				const label = opts.permission[0]!.toUpperCase() + opts.permission.slice(1);
				return { block: true, reason: `${label} denied: ${opts.check.reason ?? "no matching allow rule"}` };
			}

			// action === "ask" — delegate to parent's permission prompt
			const timedMinutes = DEFAULT_TIMED_APPROVAL_MINUTES;
			const isFile = opts.permission === "read" || opts.permission === "edit";

			let reprompt = false;
			while (true) {
				const promptOpts: PermissionPromptOptions = {
					permission: opts.permission,
					target: opts.target,
					timedApprovalMinutes: timedMinutes,
					reprompt,
				};
				if (opts.check.unapproved && opts.check.unapproved.length > 0) promptOpts.unapproved = opts.check.unapproved;
				if (opts.check.redirectTargets?.length) promptOpts.redirectTargets = opts.check.redirectTargets;
				if (opts.check.reason) promptOpts.reason = opts.check.reason;

				const result = await showPermissionPrompt(parentCtx, promptOpts);

				if (result === null) {
					ctx.abort();
					onPermissionDenied?.();
					return { block: true, reason: `User denied ${opts.permission}` };
				}

				const { approved, skipped, duration } = result;

				if (duration === "once") {
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

				const patterns: string[] = [];
				for (const [original, edited] of approved) {
					if (isFile) {
						patterns.push(toRecursiveGlob(normalizePathForMatching(edited, cwd)));
					} else {
						patterns.push(edited);
					}
				}

				const redirectPatterns: Array<{ permission: "read" | "edit"; pattern: string }> = [];
				if (opts.check.redirectTargets?.length) {
					for (const rt of opts.check.redirectTargets) {
						if (approved.has(rt.path)) {
							redirectPatterns.push({
								permission: rt.permission,
								pattern: toRecursiveGlob(normalizePathForMatching(rt.path, cwd)),
							});
						}
					}
				}

				if (duration === "session" || duration === "project" || duration === "global") {
					const modes: ProfileName[] = ["build"];
					const newRules: Ruleset = patterns.map((p) => ({
						permission: opts.permission as Rule["permission"],
						pattern: p,
						action: "allow" as const,
						modes,
					}));

					for (const rp of redirectPatterns) {
						newRules.push({
							permission: rp.permission,
							pattern: rp.pattern,
							action: "allow" as const,
							modes,
						});
					}

					// Write to BOTH storages (immediate rule propagation)
					if (duration === "project") {
						await subagentStorage.addPersistedRules(newRules);
						await parentStorage.addPersistedRules(newRules);
					} else if (duration === "global") {
						await subagentStorage.addGlobalRules(newRules);
						await parentStorage.addGlobalRules(newRules);
					} else {
						subagentStorage.addSessionRules(newRules);
						parentStorage.addSessionRules(newRules);
					}
				} else {
					const expiryType = duration === "timed" ? "time" : "turn";

					const tempRules = makeTempRules({
						permission: opts.permission,
						patterns,
						expiryType,
						minutes: timedMinutes,
					});

					for (const rp of redirectPatterns) {
						tempRules.push(...makeTempRules({
							permission: rp.permission,
							patterns: [rp.pattern],
							expiryType,
							minutes: timedMinutes,
						}));
					}

					subagentStorage.addTempRules(tempRules);
					parentStorage.addTempRules(tempRules);
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
		return `[SAFENET SUBAGENT EXPLORE MODE]
You are a read-only explore subagent. You can read files and search the codebase.

You CANNOT modify files, run commands, or ask questions.
Focus on completing the task you were given. Report your findings concisely.

## Available tools
read, grep, find, ls`;
	}

	return `[SAFENET SUBAGENT BUILD MODE]
You are a subagent running in build mode. Permission prompts will be shown to the parent session's user for approval.

Commands are evaluated against the permission ruleset:
- Allowlisted commands run silently
- Unknown commands prompt the user for approval
- Dangerous commands are blocked

Focus on completing the task you were given. Be concise in your output.

## Available tools
read, bash, edit, write, grep, find, ls`;
}
