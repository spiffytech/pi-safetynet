/**
 * child-ext.ts — the permission-enforcement extension every subagent session
 * runs. Carried by pi-submarine-core and instantiated by whoever spawns the
 * session (pi-safetynet's reviewer, pi-submarine's persistent jobs).
 *
 * The extension itself holds NO policy: every permission decision is delegated
 * to an injected `ChildServices` gate. pi-safetynet supplies its ruleset engine
 * (shared approvals, bridged prompts, auto-deny); pi-submarine standalone
 * supplies a simple confirm policy. Explore children additionally run under a
 * hard tool allowlist plus the pure sensitive-file guard.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChildServices, ChildServicesFactory, ChildVerdict } from "./host-api.ts";
import type { ReportingOptions } from "./reporting.ts";
import { capReportBody, capReportSummary } from "./report.ts";
import { isSensitivePath as defaultIsSensitivePath, normalizeToolPath } from "./paths.ts";

const SUBAGENT_EPHEMERAL_CUSTOM_TYPE = "safetynet:subagent-ephemeral";
/** customType for the one-shot settle-guard reminder injected into the child. */
const REPORT_REMINDER_CUSTOM_TYPE = "safetynet:report-reminder";

/** Name of the child→parent report tool. */
export const REPORT_TOOL_NAME = "report_to_parent";
/** Name of the reviewer's model-authored research tool (QuickJS sandboxed). */
export const RESEARCH_TOOL_NAME = "codemode_research";

const EXPLORE_TOOL_NAMES = ["read", "grep", "find", "ls", RESEARCH_TOOL_NAME];
const BUILD_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", RESEARCH_TOOL_NAME];

/** Active tool names for a subagent, plus the report tool for collaborative ones. */
export function activeToolNames(taskType: "explore" | "build", reporting: boolean): string[] {
	const base = taskType === "explore" ? EXPLORE_TOOL_NAMES : BUILD_TOOL_NAMES;
	return reporting ? [...base, REPORT_TOOL_NAME] : [...base];
}

export interface ChildExtensionOpts {
	taskType: "explore" | "build";
	cwd: string;
	/** Parent session context — permission prompts display there. */
	parentCtx: ExtensionContext;
	/** Called when the user rejects something: the whole child aborts. */
	onPermissionDenied: () => void;
	/** Enforcement provider (pi-safetynet's ruleset engine, or a local policy). */
	services: ChildServicesFactory;
	/** Spawn-time inputs forwarded to the services factory. */
	serviceInputs: { trustExternalPaths: boolean; paradigm: string; modeAliases: Record<string, string> };
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

/** Build the child extension factory for one subagent session. */
export function createChildExtension(opts: ChildExtensionOpts): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const services: ChildServices = opts.services({
			taskType: opts.taskType,
			cwd: opts.cwd,
			parentCtx: opts.parentCtx,
			trustExternalPaths: opts.serviceInputs.trustExternalPaths,
			paradigm: opts.serviceInputs.paradigm,
			modeAliases: opts.serviceInputs.modeAliases,
			onPermissionDenied: opts.onPermissionDenied,
			sendToChild: (msg) => {
				pi.sendMessage({
					customType: msg.customType,
					content: msg.content,
					display: msg.display,
				});
			},
		});
		const isSensitive = services.isSensitivePath ?? defaultIsSensitivePath;

		// Force the correct active tool set. bindExtensions resets tools to defaults
		// (read, bash, edit, write), so the subagent LLM would see edit/write/bash
		// instead of read-only tools unless we fix it here.
		pi.on("session_start", async () => {
			pi.setActiveTools(activeToolNames(opts.taskType, opts.reporting !== undefined));
		});

		registerCollaboration(pi, opts.reporting);
		services.registerChildTools?.(pi);

		if (opts.taskType === "explore") {
			// Defense-in-depth: block any tool outside the allowlist, and enforce the
			// sensitive-file block. Without it a read-only child is a
			// secret-exfiltration path the parent itself would deny (`read .env`).
			const allowedTools = new Set(activeToolNames("explore", opts.reporting !== undefined));
			pi.on("tool_call", async (event: ToolCallEvent, _ctx: ExtensionContext) => {
				if (!allowedTools.has(event.toolName)) {
					return { block: true, reason: `Tool '${event.toolName}' is not available in explore mode` };
				}
				const rawPath = (event.input as Record<string, unknown>).path;
				if (typeof rawPath === "string" && isSensitive(normalizeToolPath(rawPath))) {
					return {
						block: true,
						reason: "Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.",
					};
				}
				return undefined;
			});
		} else {
			pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
				try {
					return await services.gate({ toolName: event.toolName, input: event.input as Record<string, unknown>, ctx });
				} catch (err) {
					ctx.ui.notify(`Permission check error: ${err}`, "warning");
					// Fail closed: a check that could not complete must not allow the call.
					return { block: true, reason: `Permission check failed (${err}); blocked to be safe` } satisfies Exclude<ChildVerdict, undefined>;
				}
			});
			pi.on("agent_end", async () => {
				// Per-scope state (deny strikes) belongs to the gate; the child's own
				// turn end only needs to signal it.
				services.onTurnEnd?.();
			});
		}

		// Specialized subagents (permission reviewer, inferred-rule judge) carry
		// their own system prompt and must NOT receive the generic explore
		// identity: the reviewer otherwise reasons about "you are a read-only
		// explore subagent" as though it described the session under review.
		if (!opts.omitContextMessage) pi.on("context", async (event) => {
			const ephemeralMessage: AgentMessage & { customType: string; display: boolean } = {
				role: "custom",
				customType: SUBAGENT_EPHEMERAL_CUSTOM_TYPE,
				content: getSubagentContextMessage(opts.taskType, opts.reporting !== undefined),
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

// ─── Collaboration (report tool + settle guard) ────────────────────────────

/**
 * Register the child→parent mailbox surface for collaborative subagents:
 * the `report_to_parent` tool and the one-shot settle guard.
 *
 * The guard exists because silence alone cannot distinguish "finished, nothing
 * to say" from "stopped without reporting". It forces at most ONE extra
 * continuation per segment; `segment.nudged` makes a second settle silent, so a
 * child that ignores the nudge can never loop.
 */
function registerCollaboration(pi: ExtensionAPI, reporting: ReportingOptions | undefined): void {
	if (!reporting) return;
	// Session-wide latch, separate from the per-segment bookkeeping: once the
	// child has ever produced a real report, it must never be nudged again —
	// no matter how reporting.segment gets reset mid-run (steers, races) — or a
	// nudge loop can burn a closed task for repeated empty "nothing to report"
	// continuations, as a live build child demonstrated.
	let everReported = false;

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
			everReported = true;
			return {
				content: [{ type: "text", text: "Report delivered to parent." }],
				details: {},
			};
		},
	});

	pi.on("agent_before_settle", async () => {
		if (everReported || reporting.segment.reported || reporting.segment.nudged) return undefined;
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