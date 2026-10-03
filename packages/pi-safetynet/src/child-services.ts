/**
 * child-services.ts — pi-safetynet's `ChildServices` implementation: the
 * permission gate every build-mode child session runs behind.
 *
 * The gate reuses the exact decision flow the parent session uses — shared
 * `PermissionStorage` (approvals granted anywhere apply everywhere), the
 * ruleset checks, and the bridged parent-TUI prompt with auto-deny and
 * deny-strikes — via the injected `sendToChild`/`parentCtx` seam. Explore
 * children additionally get the reviewer's research tool here.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	RESEARCH_TOOL_NAME,
	REPORT_TOOL_NAME,
	JOB_WATCH_TOOL_NAME,
	type ChildServicesFactory,
	type ChildServicesDeps,
	type ChildGateRequest,
	type ChildVerdict,
} from "pi-submarine-core";
import { checkBashPermission, checkFileTarget, type PermissionCheck } from "../core/check.ts";
import { resolveDeny, resolvePermission as resolvePermissionShared, type HazardousDenyState } from "../pipeline.ts";
import { runResearchScript } from "../core/review-research.ts";
import { getCurrentProfile, isReadOnly } from "../core/profiles.ts";
import { loadAutoDeny, loadKeybindings } from "../core/global-config.ts";
import type { PermissionStorage } from "../core/permissions/index.ts";
import { normalizeToolPath } from "pi-submarine-core";
import type { AutoDenyConfig, PromptKeybindings, ProfileName } from "../core/types.ts";

/** Build the enforcement factory backed by the parent's permission storage. */
export function createSafetynetChildServices(storage: PermissionStorage): ChildServicesFactory {
	return (deps: ChildServicesDeps) => {
		/** Per-scope hazardous-deny counter for this subagent. Fresh per child —
		 *  parallel subagents never share the parent's counter. */
		const hazardousDenyState: HazardousDenyState = { count: 0 };
		const { cwd, trustExternalPaths, modeAliases } = deps;
		const writeProfile: ProfileName = deps.paradigm === "ro-rw" ? "rw" : "build";
		const promptKeybindings: PromptKeybindings = loadKeybindings();
		const autoDenyConfig: AutoDenyConfig = loadAutoDeny();

		/** Deliver a denial to the subagent's model: display:false nudge plus,
		 *  when visible, a display:true transcript entry for abort paths. */
		function sendDenial(text: string, mode: "hidden" | "visible"): void {
			deps.sendToChild({
				customType: "safetynet:denial",
				content: text,
				display: mode === "visible",
			});
		}

		async function resolvePermission(
			ctx: ExtensionContext,
			opts: {
				permission: "bash" | "read" | "edit";
				target: string;
				check: PermissionCheck;
				recheck: () => PermissionCheck;
			},
		): Promise<ChildVerdict> {
			return resolvePermissionShared(
				{
					displayCtx: deps.parentCtx,
					storage,
					cwd,
					allowModes: [writeProfile],
					currentReviewProfile: () => (isReadOnly(getCurrentProfile()) ? "ro" : "rw"),
					...(deps.onPermissionDenied ? { onDenied: deps.onPermissionDenied } : {}),
					keybindings: promptKeybindings,
					autoDeny: autoDenyConfig,
					hazardousDenyState,
					sendManualApproval: () => {
						deps.sendToChild({
							customType: "safetynet:manual-approval",
							content: "The user manually approved this command by interactive prompt.",
							display: false,
						});
					},
					sendDenial,
				},
				opts,
			);
		}

		async function gate(req: ChildGateRequest): Promise<ChildVerdict> {
			const profile: ProfileName = writeProfile;
			const input = req.input;
			const ctx = req.ctx;

			// The child extension's own collaboration tools. report_to_parent speaks
			// to the parent; codemode_research runs in the QuickJS sandbox that
			// enforces sensitive-path refusal itself. job_watch's file/quiet watches
			// READ and quote lines into events, so its path inputs go through the
			// same read gate as the read tool (its `run` action self-gates its command
			// through this same gate). Falling through to the fail-closed branch below
			// silently killed child reporting for months — every report_to_parent call
			// was blocked.
			if (req.toolName === REPORT_TOOL_NAME || req.toolName === RESEARCH_TOOL_NAME) {
				return undefined;
			}
			if (req.toolName === JOB_WATCH_TOOL_NAME) {
				for (const key of ["path", "logPath"]) {
					const rawPath = input[key];
					if (typeof rawPath === "string") {
						const filePath = normalizeToolPath(rawPath);
						const check = checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases);
						if (check.action === "deny") {
							return { block: true, reason: check.reason ?? `Denied: ${filePath} is not readable here` };
						}
					}
				}
				return undefined;
			}

			if (req.toolName === "bash") {
				const command = input.command as string;
				const rules = storage.getAllRules();
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
						onDenied: deps.onPermissionDenied,
						state: hazardousDenyState,
						source: check.modeDenied ? "mode" : "ruleset",
						hazardous: check.hazardous ?? false,
					});
				}

				return resolvePermission(ctx, {
					permission: "bash",
					target: command,
					check,
					recheck: () => checkBashPermission(command, profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
				});
			}

			if (req.toolName === "grep" || req.toolName === "find" || req.toolName === "ls") {
				const filePath = normalizeToolPath((input.path as string) ?? cwd);
				return resolvePermission(ctx, {
					permission: "read",
					target: filePath,
					check: checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
				});
			}

			if (req.toolName === "edit" || req.toolName === "write") {
				const filePath = normalizeToolPath(input.path as string);
				return resolvePermission(ctx, {
					permission: "edit",
					target: filePath,
					check: checkFileTarget(filePath, "edit", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					recheck: () => checkFileTarget(filePath, "edit", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
				});
			}

			if (req.toolName === "read") {
				const filePath = normalizeToolPath(input.path as string);
				return resolvePermission(ctx, {
					permission: "read",
					target: filePath,
					check: checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
					recheck: () => checkFileTarget(filePath, "read", profile, storage.getAllRules(), cwd, trustExternalPaths, modeAliases),
				});
			}

			// Tools outside the explicit list above are refused (fail closed). The
			// child's registry allowlist keeps most out; this is the backstop.
			return { block: true, reason: `Tool '${req.toolName}' is not covered by the subagent permission gate` };
		}

		return {
			gate,
			registerChildTools: (pi: ExtensionAPI) => registerResearchTool(pi, cwd),
			onTurnEnd: () => {
				hazardousDenyState.count = 0;
			},
		};
	};
}

/**
 * Model-authored research: a QuickJS-sandboxed exploration program rather than
 * host-decided "evidence gathering". Only the read-only bridges exist inside the
 * sandbox, and each one refuses protected files exactly as the tool_call gate
 * refuses them for direct reads. Registered on explore and build children alike:
 * what to look at is the child's judgment either way.
 */
function registerResearchTool(pi: ExtensionAPI, cwd: string): void {
	pi.registerTool({
		name: RESEARCH_TOOL_NAME,
		label: "Code Research",
		description:
			"Run a JavaScript research program against the repo to gather evidence in one shot. " +
			"The program is an async function body with `tools.read(path)`, `tools.grep({pattern, path})`, " +
			"`tools.find({path})`, `tools.ls({path})` and `text(value)`; `Promise.all` is allowed. " +
			"Use this to chase imports, survey directories, or match patterns broadly before deciding.",
		promptSnippet: "Explore the repo with a scripted batch of read-only calls",
		parameters: Type.Object({
			script: Type.String({ description: "Async function body that calls tools.read/grep/find/ls and ends with text(...)" }),
		}),
		async execute(_toolCallId, params) {
			const output = await runResearchScript({
				script: String(params.script ?? ""),
				cwd,
			});
			return {
				content: [{ type: "text", text: output || "(script produced no output)" }],
				details: {},
			};
		},
	});
}