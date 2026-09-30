/**
 * pi-submarine — persistent two-way background subagents for pi.
 *
 * Registers the `subagent_*` tool surface (run/status/send/close/bash_output),
 * the job registry, and the wake/report plumbing. Lives as its own pi package
 * so it installs (and toggles) independently of pi-safetynet.
 *
 * Everything policy-ish is delegated: when pi-safetynet is installed its
 * `SafetynetHost` (published on pi.events) supplies the live mode state and the
 * child permission gate; standalone, a simple confirm policy applies. The host
 * may arrive after this factory runs (load order is package order), so every
 * host access goes through the late-bound `host` binding below.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	accumulateUsage,
	capReportMessage,
	isSensitivePath,
	normalizeToolPath,
	requestSafetynetHost,
	zeroUsage,
	type ChildServicesFactory,
	type SafetynetHost,
} from "pi-submarine-core";
import {
	SubagentJobManager,
	REPORT_CUSTOM_TYPE,
	WAKE_CUSTOM_TYPE,
	type JobStatus,
	type SubagentJob,
} from "./src/subagent-jobs.ts";
import { startPersistentSubagent } from "./src/subagent-runner.ts";
import { consumeSubagentFailure, clearSubagentFailures, recordSubagentFailure } from "./src/failure.ts";
import { standaloneChildServices } from "./src/standalone-services.ts";

// ─── Host binding ──────────────────────────────────────────────────────────

/** Live host binding: set when pi-safetynet announces itself (possibly late). */
let host: SafetynetHost | undefined;

const isReadOnlyProfile = (profile: string): boolean => profile === "ro" || profile === "plan";
const currentProfile = (): string => host?.getProfile() ?? "build";
const currentParadigm = (): string => host?.getParadigm() ?? "plan-build";
const currentModeAliases = (): Record<string, string> => host?.getModeAliases() ?? {};
const trustExternalActive = (): boolean => host?.trustExternalPaths() ?? false;
const childServices: ChildServicesFactory = (...args) =>
	(host ? host.childServices(...args) : standaloneChildServices(...args));

/** Legacy `~/.config/pi-safetynet/config.json` `"subagents": []` shutoff,
 *  honored for one release with a deprecation notice. */
export function legacySubagentsDisabled(): boolean {
	try {
		const raw = readFileSync(join(process.env.HOME ?? "/home", ".config/pi-safetynet/config.json"), "utf-8");
		const parsed = JSON.parse(raw) as { subagents?: unknown };
		return Array.isArray(parsed.subagents) && parsed.subagents.length === 0;
	} catch {
		return false;
	}
}

// ─── State ────────────────────────────────────────────────────────────────

/** Persistent subagent registry (initialized by the extension factory). */
let jobManager: SubagentJobManager | undefined;
/** Live UI context, captured on session_start for footer/tool updates. */
let uiCtx: ExtensionContext | undefined;
/** True while the parent is compacting; wakes are deferred. */
let compactionActive = false;
/** Safety watchdog: clears compactionActive if no terminal compaction event lands. */
let compactionWatchdog: ReturnType<typeof setTimeout> | undefined;
/** True while the parent is mid-turn; wakes/reports are deferred to the turn boundary. */
let parentBusy = false;
/** Current model display string (provider/model-id), for tool-call rendering. */
let currentModelDisplay = "";
/** Whether the current model supports extended thinking. */
let currentModelSupportsReasoning = false;
/** Current thinking level, for tool-call rendering. */
let currentThinkingLevel = "off";

/** Refresh the "waiting on subagents" footer indicator. */
function refreshJobsStatus(): void {
	if (!uiCtx || !jobManager) return;
	const jobs = jobManager.list().filter((j) => j.state !== "failed");
	const running = jobs.filter((j) => j.state === "starting" || j.state === "running").length;
	const idle = jobs.filter((j) => j.state === "idle").length;
	try {
		uiCtx.ui.setStatus("safetynet-jobs", jobs.length ? `⏳ ${running} running, ${idle} idle` : undefined);
	} catch {
		/* footer may be torn down */
	}
}

// ─── Renderers ────────────────────────────────────────────────────────────

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
	container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
	return container;
}

// ─── Tools ────────────────────────────────────────────────────────────────

function registerSubagentTools(pi: ExtensionAPI) {
	// A single dispatch tool; the child inherits the parent's ro/rw mode at spawn.

	function resolveModel(modelSpec: string | undefined, ctx: ExtensionContext) {
		if (!modelSpec) return ctx.model;
		const slashIdx = modelSpec.indexOf("/");
		if (slashIdx < 1) return ctx.model;
		const provider = modelSpec.slice(0, slashIdx);
		const modelId = modelSpec.slice(slashIdx + 1);
		return ctx.modelRegistry.find(provider, modelId) ?? ctx.model;
	}

	const fmtStatus = (s: JobStatus): string => {
		const parts = [`${s.id} [${s.state}]`, `mode:${s.spawnMode}`];
		if (s.usage.totalTokens) parts.push(`tokens:${s.usage.totalTokens}`);
		if (s.state === "idle") parts.push(s.reported ? "reported" : "silent");
		if (s.bash) parts.push(`bash:$ ${s.bash.command}`);
		if (s.lastReport) parts.push(`last: ${s.lastReport.summary}`);
		return parts.join(" ");
	};

	pi.registerTool({
		name: "subagent_run",
		label: "Subagent",
		description: [
			"Spawn a persistent background subagent that inherits your current read-only/read-write mode.",
			"Returns a job id immediately; the subagent reports back via report_to_parent and wakes you when it goes idle.",
			"Use subagent_send to message it, subagent_status to inspect it, subagent_bash_output to tail its current bash command, and subagent_close to end it.",
		].join(" "),
		promptSnippet: "Spawn a background subagent (async, two-way)",
		promptGuidelines: [
			"Use subagent_run for self-contained work you can delegate. It returns immediately; do not expect the answer in the tool result.",
			"Keep the conversation going while it runs; you will be woken when it reports, finishes, or needs attention.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete, self-sufficient task for the subagent" }),
			model: Type.Optional(Type.String({ description: "Model (provider/model-id). Defaults to the current model." })),
		}),
		renderResult: renderSubagentResult,
		renderCall: (args, theme, context) => renderSubagentCall("Subagent", args, theme, context),
		...(typeof process !== "undefined" && { renderShell: "self" as const }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!jobManager) {
				return { content: [{ type: "text", text: "Subagent manager unavailable." }], details: {} as Record<string, unknown> };
			}
			const manager = jobManager;
			const spawnMode = currentProfile();
			let job: SubagentJob;
			try {
				job = manager.create({ prompt: params.prompt, cwd: ctx.cwd, spawnMode });
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					details: {} as Record<string, unknown>,
				};
			}
			const taskType = isReadOnlyProfile(spawnMode) ? ("explore" as const) : ("build" as const);
			startPersistentSubagent({
				jobId: job.id,
				taskType,
				parentCtx: ctx,
				cwd: ctx.cwd,
				model: resolveModel(params.model, ctx),
				thinkingLevel: pi.getThinkingLevel(),
				trustExternalPaths: trustExternalActive(),
				paradigm: currentParadigm(),
				modeAliases: currentModeAliases(),
				services: childServices,
				reporting: {
					send: (r) => manager.submitReport(job.id, r),
					segment: job.segment,
				},
				isClosed: () => job.closed,
				onControls: (controls) => {
					manager.setControls(job.id, controls);
					void controls.prompt(job.prompt);
					refreshJobsStatus();
				},
				onBashOutput: (command, tail) => manager.recordBash(job.id, command, tail),
				onUsage: (usage) => manager.addUsage(job.id, usage),
				onIdle: () => {
					manager.idle(job.id);
					refreshJobsStatus();
				},
				onError: (error) => {
					manager.fail(job.id, error);
					refreshJobsStatus();
				},
			});
			return {
				content: [{ type: "text", text: `Started ${job.id}. You will be woken when it reports or goes idle.` }],
				details: { jobId: job.id },
			};
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect background subagents: state, mode, last report, and current bash tail. Pass ids, or omit for all live jobs.",
		promptSnippet: "Inspect background subagents",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Type.String(), { description: "Job ids; omit for all live jobs" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!jobManager) return { content: [{ type: "text", text: "Subagent manager unavailable." }], details: {} as Record<string, unknown> };
			const statuses = params.ids?.length
				? params.ids.map((id) => jobManager!.status(id)).filter((s): s is JobStatus => s !== undefined)
				: jobManager.allStatuses();
			if (statuses.length === 0) return { content: [{ type: "text", text: "No matching subagents." }], details: { jobs: [] } };
			// Pull undelivered reports so content is never lost to a missed push.
			const pulled: string[] = [];
			for (const s of statuses) {
				for (const r of jobManager!.takeUndeliveredReports(s.id)) {
					const head = `[${s.id}] ${r.summary}`;
					pulled.push(r.body ? `${head}\n${r.body}` : head);
				}
			}
			// Deliver each job's undelivered usage delta once, so spend is not lost
			// when a job is never explicitly closed (the footer sums tool-result usage).
			const usage = zeroUsage();
			let hasUsage = false;
			for (const s of statuses) {
				const job = jobManager!.get(s.id);
				const delta = job ? jobManager!.deliverUsage(job) : undefined;
				if (delta) {
					accumulateUsage(usage, delta);
					hasUsage = true;
				}
			}
			const text = statuses.map(fmtStatus).join("\n") + (pulled.length ? `\n\n---\n\n${pulled.join("\n\n---\n\n")}` : "");
			return {
				content: [{ type: "text", text }],
				details: { jobs: statuses, ...(pulled.length ? { reports: pulled } : {}) },
				...(hasUsage ? { usage } : {}),
			};
		},
	});

	pi.registerTool({
		name: "subagent_send",
		label: "Send to Subagent",
		description: "Send a message to a running or idle background subagent. Delivered at its next safe point; you are woken on its next idle.",
		promptSnippet: "Message a background subagent",
		parameters: Type.Object({
			id: Type.String({ description: "Job id" }),
			message: Type.String({ description: "Message to deliver to the subagent" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const job = jobManager?.get(params.id);
			if (!job) return { content: [{ type: "text", text: `Unknown or closed subagent: ${params.id}` }], details: {} as Record<string, unknown> };
			if (!job.controls) return { content: [{ type: "text", text: `${params.id} is still starting; try again shortly.` }], details: {} as Record<string, unknown> };
			// A steer is new work the parent should hear about: reset the segment so
			// the one-shot settle guard nudges the child to report it.
			jobManager!.beginSegment(job.id);
			void job.controls.prompt(capReportMessage(params.message));
			refreshJobsStatus();
			return { content: [{ type: "text", text: `Delivered to ${job.id}.` }], details: { jobId: job.id } };
		},
	});

	pi.registerTool({
		name: "subagent_close",
		label: "Close Subagent",
		description: "End a background subagent and release its session.",
		promptSnippet: "End a background subagent",
		parameters: Type.Object({ id: Type.String({ description: "Job id" }) }),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			if (!jobManager) return { content: [{ type: "text", text: "Subagent manager unavailable." }], details: {} as Record<string, unknown> };
			const usage = jobManager.close(params.id);
			refreshJobsStatus();
			return {
				content: [{ type: "text", text: `Closed ${params.id}.` }],
				details: { jobId: params.id },
				...(usage ? { usage } : {}),
			};
		},
	});

	pi.registerTool({
		name: "subagent_bash_output",
		label: "Subagent Bash Output",
		description: "Return the current/most-recent bash command and output tail for a background subagent.",
		promptSnippet: "Tail a background subagent's bash output",
		parameters: Type.Object({
			id: Type.String({ description: "Job id" }),
			tailN: Type.Optional(Type.Number({ description: "Lines of output to return (default 50, max 500)" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const job = jobManager?.get(params.id);
			if (!job) return { content: [{ type: "text", text: `Unknown or closed subagent: ${params.id}` }], details: {} as Record<string, unknown> };
			const lines = params.tailN && params.tailN > 0 ? Math.min(params.tailN, 500) : 50;
			const bash = job.bash;
			if (!bash) return { content: [{ type: "text", text: `${params.id}: no bash call yet.` }], details: { jobId: params.id } };
			const tail = bash.tail.split("\n").slice(-lines).join("\n");
			return {
				content: [{ type: "text", text: `$ ${bash.command}\n${tail || "(no output yet)"}` }],
				details: { jobId: params.id, command: bash.command, tail },
			};
		},
	});
}

// ─── Entry ────────────────────────────────────────────────────────────────

export default function piSubmarineExtension(pi: ExtensionAPI): void {
	const legacyOff = legacySubagentsDisabled();

	// Track the live model for tool-call rendering (pi's own events — no host needed).
	pi.on("model_select", async (event) => {
		currentModelDisplay = `${event.model.provider}/${event.model.id}`;
		currentModelSupportsReasoning = event.model.reasoning ?? false;
	});
	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
	});

	// Find pi-safetynet's host (whenever it loads). Host presence only upgrades
	// enforcement and mode awareness; registration below does not depend on it.
	requestSafetynetHost(pi.events, (h) => {
		host = h;
	});

	if (legacyOff) {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					'`"subagents": []` in ~/.config/pi-safetynet/config.json is deprecated and will be removed; use `pi config` to disable pi-submarine (or remove the package) instead. Subagents stay disabled for now.',
					"warning",
				);
			}
		});
		return;
	}

	jobManager = new SubagentJobManager({
		sendToParent: (text, opts) => {
			pi.sendMessage(
				{ customType: opts.urgent ? WAKE_CUSTOM_TYPE : REPORT_CUSTOM_TYPE, content: text, display: false },
				opts.urgent ? { triggerTurn: true, deliverAs: "followUp" } : {},
			);
		},
		isCompacting: () => compactionActive,
		isParentBusy: () => parentBusy,
	});

	registerSubagentTools(pi);

	pi.on("session_start", async (event, ctx) => {
		uiCtx = ctx;
		if (ctx.model) {
			currentModelDisplay = `${ctx.model.provider}/${ctx.model.id}`;
			currentModelSupportsReasoning = ctx.model.reasoning ?? false;
		}
		currentThinkingLevel = pi.getThinkingLevel();
		jobManager?.resetForSession();
		compactionActive = false;
		parentBusy = false;
		if (compactionWatchdog) {
			clearTimeout(compactionWatchdog);
			compactionWatchdog = undefined;
		}
		refreshJobsStatus();
	});

	// Report failed subagents as tool errors. pi has no isError on AgentToolResult — it
	// only sets one when execute() throws, which would discard the partial output and
	// usage — so the verdict is recorded by execute() and applied here.
	pi.on("tool_result", async (event) => consumeSubagentFailure(event.toolCallId));

	// Parent→child mode discipline: children spawned under a different mode die
	// when the user actually sends their next message under the new mode. Flipping
	// modes while idle costs nothing.
	pi.on("input", async (_event, ctx) => {
		uiCtx = ctx;
		jobManager?.killByMode(currentProfile());
		refreshJobsStatus();
	});

	// Defer subagent wakes while the parent compacts; drain when it finishes.
	pi.on("session_before_compact", async () => {
		compactionActive = true;
		if (compactionWatchdog) clearTimeout(compactionWatchdog);
		// Safety: if no terminal compaction event ever lands, stop deferring wakes.
		compactionWatchdog = setTimeout(() => {
			compactionWatchdog = undefined;
			compactionActive = false;
			jobManager?.drain();
		}, 5 * 60_000);
	});
	const onCompactionDone = async () => {
		if (compactionWatchdog) {
			clearTimeout(compactionWatchdog);
			compactionWatchdog = undefined;
		}
		compactionActive = false;
		jobManager?.drain();
	};
	pi.on("session_compact", onCompactionDone);
	pi.on("session_compact_failed", onCompactionDone);

	pi.on("session_shutdown", async () => {
		if (compactionWatchdog) {
			clearTimeout(compactionWatchdog);
			compactionWatchdog = undefined;
		}
		jobManager?.dispose();
		compactionActive = false;
		parentBusy = false;
		uiCtx = undefined;
	});

	pi.on("agent_start", async () => {
		parentBusy = true;
	});

	pi.on("agent_end", async () => {
		// The turn is over: deliver anything held back, re-deriving liveness now so a
		// job closed during the turn produces no wake at all.
		parentBusy = false;
		jobManager?.drain();
		clearSubagentFailures();
	});
}

// Re-exported pure seams for tests and hosts.
export type { SafetynetHost, ChildServicesFactory };
export { isSensitivePath, normalizeToolPath };