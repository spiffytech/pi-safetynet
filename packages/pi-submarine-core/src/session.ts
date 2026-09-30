/**
 * session.ts — spawn in-process subagent AgentSessions via the SDK.
 *
 * Shared by the one-shot reviewer path (`runSubagent`, pi-safetynet) and
 * pi-submarine's persistent two-way runner, so provider/auth/session setup
 * lives in exactly one place. Pure orchestration: permission enforcement is
 * whatever `ChildServices` the caller injects (see host-api.ts).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ChildServicesFactory } from "./host-api.ts";
import type { ReportingOptions } from "./reporting.ts";
import { createChildExtension, REPORT_TOOL_NAME, RESEARCH_TOOL_NAME } from "./child-ext.ts";
import { toDisplayPath } from "./paths.ts";
import { accumulateUsage, snapshotUsage, zeroUsage } from "./usage.ts";

/** Extension factory that overrides the system prompt via before_agent_start return. */
function createSystemPromptExtension(systemPrompt: string): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (_event) => {
			return { systemPrompt };
		});
	};
}

export interface SubagentSessionConfig {
	taskType: "explore" | "build";
	cwd: string;
	parentCtx: ExtensionContext;
	model?: Model<any> | undefined;
	thinkingLevel?: string | undefined;
	systemPrompt?: string;
	reporting?: ReportingOptions;
	/** Persistent jobs keep pi's compaction on; the one-shot reviewer turns it off. */
	compactionEnabled?: boolean;
	onPermissionDenied: () => void;
	/** Permission enforcement for the child. Required for build sessions. */
	services?: ChildServicesFactory | undefined;
	trustExternalPaths?: boolean | undefined;
	/** Active paradigm ("plan-build" | "ro-rw" by convention). */
	paradigm?: string | undefined;
	/** Mode-name aliasing for rule matching. */
	modeAliases?: Record<string, string> | undefined;
}

export type CreateSubagentSessionResult =
	| { ok: true; session: CreateAgentSessionResult["session"] }
	| { ok: false; kind: "no_model" | "create"; message: string };

/**
 * `createAgentSession`'s `tools` option is an allowlist, so extension tools
 * must be listed here or they are filtered out of the registry and cannot be
 * activated later via setActiveTools. Exported for regression testing.
 */
export function subagentToolNames(taskType: "explore" | "build", reporting: boolean): string[] {
	const base = taskType === "explore"
		? ["read", "grep", "find", "ls", RESEARCH_TOOL_NAME]
		: ["read", "bash", "edit", "write", "grep", "find", "ls", RESEARCH_TOOL_NAME];
	return reporting ? [...base, REPORT_TOOL_NAME] : base;
}

/**
 * Create (but do not prompt) a subagent AgentSession.
 *
 * Shared by the one-shot reviewer path (`runSubagent`) and the persistent
 * two-way runner so provider/auth/session setup lives in exactly one place.
 */
export async function createSubagentSession(cfg: SubagentSessionConfig): Promise<CreateSubagentSessionResult> {
	if (cfg.taskType === "build" && !cfg.services) {
		return { ok: false, kind: "create", message: "Build subagent requires permission services (ChildServicesFactory)" };
	}
	const agentDir = process.env.PI_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;

	const modelRuntime = await ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
	});

	const settingsManager = SettingsManager.create(cfg.cwd, agentDir);
	if (!cfg.compactionEnabled) settingsManager.setCompactionEnabled(false);

	const tools = subagentToolNames(cfg.taskType, cfg.reporting !== undefined);

	let sessionRef: { abort: () => void } | null = null;
	const loader = new DefaultResourceLoader({
		cwd: cfg.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			createChildExtension({
				taskType: cfg.taskType,
				cwd: cfg.cwd,
				parentCtx: cfg.parentCtx,
				onPermissionDenied: () => {
					cfg.onPermissionDenied();
					sessionRef?.abort();
				},
				services: cfg.services ?? failClosedServices,
				serviceInputs: {
					trustExternalPaths: cfg.trustExternalPaths ?? false,
					paradigm: cfg.paradigm ?? "plan-build",
					modeAliases: cfg.modeAliases ?? {},
				},
				omitContextMessage: cfg.systemPrompt !== undefined,
				...(cfg.reporting ? { reporting: cfg.reporting } : {}),
			}),
			cfg.systemPrompt ? createSystemPromptExtension(cfg.systemPrompt) : null,
		].filter(Boolean) as any[],
	});
	await loader.reload();

	const model = cfg.model ?? cfg.parentCtx.model;
	if (!model) return { ok: false, kind: "no_model", message: "No model available in parent context." };

	const providerId = model.provider;
	const config = cfg.parentCtx.modelRegistry.getRegisteredProviderConfig(providerId);
	const native = cfg.parentCtx.modelRegistry.getRegisteredNativeProvider(providerId);
	if (config) {
		modelRuntime.registerProvider(providerId, config);
	} else if (native) {
		modelRuntime.registerNativeProvider(native);
	}

	const authStatus = cfg.parentCtx.modelRegistry.getProviderAuthStatus(providerId);
	if (authStatus.source === "runtime") {
		const runtimeKey = await cfg.parentCtx.modelRegistry.getApiKeyForProvider(providerId);
		if (runtimeKey) await modelRuntime.setRuntimeApiKey(providerId, runtimeKey);
	}
	await modelRuntime.refresh({ allowNetwork: false });

	let result: CreateAgentSessionResult;
	try {
		result = await createAgentSession({
			cwd: cfg.cwd,
			model,
			tools,
			thinkingLevel: cfg.thinkingLevel as any,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cfg.cwd),
			settingsManager,
		});
	} catch (err) {
		return { ok: false, kind: "create", message: String(err) };
	}

	const session = result.session;
	sessionRef = session;
	await session.bindExtensions({
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async (_entryId: string) => ({ cancelled: true }),
			navigateTree: async (_targetId: string) => ({ cancelled: true }),
			switchSession: async (_sessionPath: string) => ({ cancelled: true }),
			reload: async () => {},
		},
	});
	return { ok: true, session };
}

/** Never-used fallback kept for type completeness: explore sessions hold no
 *  gate at all; the build path above refuses to start without real services. */
const failClosedServices: ChildServicesFactory = () => ({
	gate: async () => ({ block: true, reason: "No permission services attached to this subagent" }),
});

export interface SubagentOptions {
	taskType: "explore" | "build";
	prompt: string;
	parentCtx: ExtensionContext;
	signal?: AbortSignal | undefined;
	onUpdate?: AgentToolUpdateCallback<unknown> | undefined;
	cwd: string;
	model?: Model<any> | undefined;
	thinkingLevel?: string | undefined;
	trustExternalPaths?: boolean;
	/** Active paradigm (ro-rw vs plan-build) for canonical subagent mode names. */
	paradigm?: string;
	/** Mode-name aliasing for rule matching (plan→ro / build→rw bijection). */
	modeAliases?: Record<string, string>;
	services?: ChildServicesFactory | undefined;
	/** Custom system prompt to replace the default (applied via before_agent_start return). */
	systemPrompt?: string;
	/** Override the default 300s timeout. */
	timeoutMs?: number;
}

/** Max agent turns before we abort the subagent. */
const MAX_TURNS = 50;
/** Wall-clock timeout in ms before we abort the subagent. */
const TIMEOUT_MS = 300_000;

/** Format a subagent tool invocation as a concise activity label. */
function formatActivity(toolName: string, args: Record<string, unknown>, cwd: string): string {
	const truncate = (s: string, max = 60) => s.length > max ? s.slice(0, max - 1) + "…" : s;
	const displayPath = (p: unknown) => truncate(toDisplayPath(String(p ?? ""), { cwd }));
	switch (toolName) {
		case "read": return `Reading ${displayPath(args.file_path ?? args.path)}`;
		case "bash": return `Running: ${truncate(String(args.command ?? ""))}`;
		case "grep": return `Searching: ${truncate(String(args.pattern ?? ""))}`;
		case "find": return `Finding: ${truncate(String(args.pattern ?? ""))}`;
		case "ls": return `Listing: ${displayPath(args.path ?? ".")}`;
		case "write": return `Writing: ${displayPath(args.file_path ?? args.path)}`;
		case "edit": return `Editing: ${displayPath(args.file_path ?? args.path)}`;
		default: return toolName;
	}
}

export async function runSubagent(opts: SubagentOptions): Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	/** Usage accumulated by the subagent. Pi persists this on the parent's toolResult
	 *  entry, which is what puts delegated spend into the normal stats line and
	 *  /session without any extension-side bookkeeping. */
	usage: Usage;
}> {
	// Declared before any early return so every exit path can attach it.
	const usage = zeroUsage();
	const { taskType, prompt, parentCtx, signal, onUpdate, cwd } = opts;

	// A signal that is already aborted means the caller cancelled this work —
	// e.g. the reviewer's deadline fired and the chain is spawning the next
	// model with the now-dead signal. `addEventListener` on an already-aborted
	// signal never invokes its listener, so without this check the session would
	// boot and run to completion despite the cancel.
	if (signal?.aborted) {
		return {
			content: [{ type: "text", text: "Subagent aborted." }],
			details: { aborted: true, taskType },
			usage: snapshotUsage(usage),
		};
	}

	let hitPermissionDenied = false;
	const created = await createSubagentSession({
		taskType,
		cwd,
		parentCtx,
		...(opts.model !== undefined ? { model: opts.model } : {}),
		...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
		...(opts.trustExternalPaths !== undefined ? { trustExternalPaths: opts.trustExternalPaths } : {}),
		...(opts.paradigm !== undefined ? { paradigm: opts.paradigm } : {}),
		...(opts.modeAliases !== undefined ? { modeAliases: opts.modeAliases } : {}),
		...(opts.services !== undefined ? { services: opts.services } : {}),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		compactionEnabled: false,
		onPermissionDenied: () => {
			hitPermissionDenied = true;
		},
	});
	if (!created.ok) {
		return {
			content: [{
				type: "text",
				text: created.kind === "no_model"
					? "Error: No model available in parent context."
					: `Error creating subagent session: ${created.message}`,
			}],
			details: { error: created.kind === "no_model" ? "no_model" : created.message },
			usage: snapshotUsage(usage),
		};
	}
	const { session } = created;

	// bindExtensions resets active tools to defaults.
	// The subagent child extension fixes this in its session_start handler
	// via pi.setActiveTools().

	let fullText = "";
	let turnCount = 0;
	let hitTurnLimit = false;
	let hitTimeout = false;
	// Provider failures arrive as an assistant message with stopReason "error", not as a
	// thrown exception, so `session.prompt()` resolves normally and this is the only
	// signal. Captured here so the result can be reported as a tool error.
	let modelError: string | undefined;

	// Turn cap: end the run gracefully after MAX_TURNS completed turns. Replaces the
	// old turn_end abort, which cut the model off mid-batch. `finishTurn` runs after
	// the assistant message and tool results are finalized, before `turn_end`;
	// returning `{ action: "end" }` lets the partial output and usage settle.
	//
	// AgentSession installs its own finishTurn wrapper at construction (to dispatch
	// `turn_end` extension boundaries), so we must wrap and delegate rather than
	// replace it.
	const priorFinishTurn = session.agent.finishTurn;
	session.agent.finishTurn = async (turn, signal) => {
		turnCount++;
		if (turnCount >= MAX_TURNS) {
			hitTurnLimit = true;
			return { action: "end" };
		}
		// Normalize the prior hook's `void` return to `undefined` for FinishTurn.
		return (await priorFinishTurn?.(turn, signal)) as { action: "continue" | "end" } | undefined;
	};
	const activities: string[] = [];

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: fullText }],
			details: { activities },
		});
	};

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			activities.push(formatActivity(event.toolName, event.args, cwd));
			emitUpdate();
		}
		if (event.type === "message_update") {
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta" && delta.delta) {
				fullText += delta.delta;
				emitUpdate();
			}
		}
		if (event.type === "message_end") {
			const msg = event.message;
			if (msg.role === "assistant") {
				// Capture error message from failed model calls
				if ((msg as any).stopReason === "error" && (msg as any).errorMessage && !fullText.trim()) {
					fullText = `Error: ${(msg as any).errorMessage}`;
					emitUpdate();
				}
				if ((msg as any).stopReason === "error" && (msg as any).errorMessage) {
					modelError = String((msg as any).errorMessage);
				}
				// Capture text from the final message (thinking models may not emit text_delta)
				if (!fullText.trim()) {
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							fullText = part.text;
							emitUpdate();
						}
					}
				}
				if (msg.usage) {
					accumulateUsage(usage, msg.usage);
					emitUpdate();
				}
			}
		}
	});

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		session.abort();
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	const effectiveTimeout = opts.timeoutMs ?? TIMEOUT_MS;
	const timeoutId = setTimeout(() => {
		hitTimeout = true;
		session.abort();
	}, effectiveTimeout);

	try {
		await session.prompt(prompt);
	} catch (err) {
		if (!aborted && !hitTurnLimit && !hitTimeout && !hitPermissionDenied) {
			return {
				content: [{ type: "text", text: `Subagent error: ${err}` }],
				details: { error: String(err), activities },
				usage: snapshotUsage(usage),
			};
		}
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}

	if (!fullText.trim()) {
		const reason = hitPermissionDenied ? "Subagent stopped: permission denied."
			: aborted ? "Subagent aborted."
			: "Subagent completed with no output.";
		return {
			content: [{ type: "text", text: reason }],
			details: { aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, taskType, activities, ...(modelError ? { error: modelError } : {}) },
			usage: snapshotUsage(usage),
		};
	}

	let suffix = "";
	if (hitPermissionDenied) suffix += "\n[Subagent stopped: permission denied]";
	if (hitTurnLimit) suffix += `\n[Subagent hit turn limit (${MAX_TURNS})]`;
	if (hitTimeout) suffix += `\n[Subagent hit timeout (${effectiveTimeout / 1000}s)]`;

	return {
		content: [{ type: "text", text: fullText + suffix }],
		details: { taskType, aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, turnCount, activities, ...(modelError ? { error: modelError } : {}) },
		usage: snapshotUsage(usage),
	};
}