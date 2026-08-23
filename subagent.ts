/**
 * Subagent orchestration — spawn in-process AgentSessions via the SDK.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { AutoDenyConfig, Paradigm, ProfileName, ModeAliases, Ruleset } from "./types.ts";
import type { PromptKeybindings } from "./prompts.ts";
import type { PermissionStorage } from "./permissions/index.ts";
import { toDisplayPath } from "./project.ts";
import { createSubagentSafetynetExtension } from "./subagent-safetynet.ts";

/** Extension factory that overrides the system prompt via before_agent_start return. */
function createSystemPromptExtension(systemPrompt: string): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", async (_event) => {
			return { systemPrompt };
		});
	};
}


export type SubagentTaskType = "explore" | "build";

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** Add two SubagentUsage objects, returning a new object. */
export function addUsage(a: SubagentUsage, b: SubagentUsage): SubagentUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

/** Format a token count like the built-in footer (1.2k, 45k, 1.5M). */
export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Format SubagentUsage as a compact string (e.g. "+↑20k ↓8k $0.023"). */
export function formatSubagentUsage(usage: SubagentUsage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokenCount(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokenCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(3)}`);
	return parts.join(" ");
}

export interface SubagentOptions {
	taskType: SubagentTaskType;
	prompt: string;
	parentCtx: ExtensionContext;
	parentStorage: PermissionStorage;
	initialRules: Ruleset;
	signal?: AbortSignal | undefined;
	onUpdate?: AgentToolUpdateCallback<unknown> | undefined;
	cwd: string;
	model?: Model<any> | undefined;
	thinkingLevel?: string | undefined;
	trustExternalPaths?: boolean;
	/** Inherited from parent: prompt keybindings for the bridged permission prompt. */
	promptKeybindings: PromptKeybindings;
	/** Inherited from parent: auto-deny behaviour for rule-denies. */
	autoDenyConfig: AutoDenyConfig;
	/** Active paradigm (ro-rw vs plan-build) for canonical subagent mode names. */
	paradigm?: Paradigm;
	/** Mode-name aliasing for rule matching (plan→ro / build→rw bijection). */
	modeAliases?: ModeAliases;
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
}> {
	const { taskType, prompt, parentCtx, parentStorage, initialRules, signal, onUpdate, cwd } = opts;

	const agentDir = process.env.PI_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;

	// Build a ModelRuntime from the same agentDir that `createAgentSession` would use
	// internally if we passed none. Constructing it explicitly lets us pass the async
	// `modelRuntime` option (0.80.8 replaced the sync `modelRegistry` option).
	const authPath = `${agentDir}/auth.json`;
	const modelsPath = `${agentDir}/models.json`;
	const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });

	const settingsManager = SettingsManager.create(cwd, agentDir);
	settingsManager.setCompactionEnabled(false);

	const tools = taskType === "explore"
		? ["read", "grep", "find", "ls"]
		: ["read", "bash", "edit", "write", "grep", "find", "ls"];

	let hitPermissionDenied = false;

	// Session needs to exist before we can create the onPermissionDenied callback,
	// but the extension factory runs during loader.reload() which is before the session
	// is created. So we use an indirection: the extension captures the ref, and we
	// set it after the session is created.
	let sessionRef: { abort: () => void } | null = null;
	const onPermissionDenied = () => {
		hitPermissionDenied = true;
		sessionRef?.abort();
	};
	const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
		createSubagentSafetynetExtension({
			taskType,
			parentCtx,
			parentStorage,
			initialRules,
			cwd,
			onPermissionDenied,
			trustExternalPaths: opts.trustExternalPaths ?? false,
			promptKeybindings: opts.promptKeybindings,
			autoDenyConfig: opts.autoDenyConfig,
			paradigm: opts.paradigm ?? "plan-build",
			modeAliases: opts.modeAliases ?? {},
		}),
		opts.systemPrompt ? createSystemPromptExtension(opts.systemPrompt) : null,
		].filter(Boolean) as any[],
	};

	const loader = new DefaultResourceLoader(loaderOpts);
	await loader.reload();


	const model = opts.model ?? parentCtx.model;
	if (!model) {
		return {
			content: [{ type: "text", text: "Error: No model available in parent context." }],
			details: { error: "no_model" },
		};
	}

	// Forward extension-registered providers from the parent ModelRegistry so the
	// subagent can resolve auth for non-built-in providers (e.g. hyper).
	// - Config-registered providers are re-registered as config.
	// - Native providers (full Provider objects, e.g. hyper/neuralwatt registered via
	//   pi.registerProvider(Provider)) are passed through as-is — re-composing them from
	//   parts loses streamSimple/refreshModels/headers and can mislabel OAuth as unconfigured.
	const providerId = model.provider;
	const config = parentCtx.modelRegistry.getRegisteredProviderConfig(providerId);
	const native = parentCtx.modelRegistry.getRegisteredNativeProvider(providerId);
	if (config) {
		modelRuntime.registerProvider(providerId, config);
	} else if (native) {
		modelRuntime.registerNativeProvider(native);
	}

	// Runtime API keys (set via setRuntimeApiKey, e.g. /apikey or another extension) live
	// only in the parent's runtime and are invisible to the fresh subagent ModelRuntime,
	// which reads auth.json. Forward them so a runtime-keyed provider doesn't fail with
	// "No API key found". OAuth providers are excluded — they keep full refresh semantics.
	const authStatus = parentCtx.modelRegistry.getProviderAuthStatus(providerId);
	if (authStatus.source === "runtime") {
		const runtimeKey = await parentCtx.modelRegistry.getApiKeyForProvider(providerId);
		if (runtimeKey) await modelRuntime.setRuntimeApiKey(providerId, runtimeKey);
	}

	// Settle the snapshot (provider configured + auth type) before createAgentSession
	// asserts auth on it; otherwise the first prompt can race an unawaited refresh.
	await modelRuntime.refresh({ allowNetwork: false });

	let result: CreateAgentSessionResult;
	try {
		result = await createAgentSession({
			cwd,
			model,
			tools,
			thinkingLevel: opts.thinkingLevel as any,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});
	} catch (err) {
		return {
			content: [{ type: "text", text: `Error creating subagent session: ${err}` }],
			details: { error: String(err) },
		};
	}

	const { session } = result;
	sessionRef = session; // wire up the abort target for onPermissionDenied

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
	// bindExtensions resets active tools to defaults.
	// The subagent safetynet extension fixes this in its session_start handler
	// via pi.setActiveTools().

	let fullText = "";
	let turnCount = 0;
	let hitTurnLimit = false;
	let hitTimeout = false;
	const activities: string[] = [];
	const cumulativeUsage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: fullText }],
			details: { activities, usage: { ...cumulativeUsage } },
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
					cumulativeUsage.input += msg.usage.input || 0;
					cumulativeUsage.output += msg.usage.output || 0;
					cumulativeUsage.cacheRead += msg.usage.cacheRead || 0;
					cumulativeUsage.cacheWrite += msg.usage.cacheWrite || 0;
					cumulativeUsage.cost += msg.usage.cost?.total || 0;
					emitUpdate();
				}
			}
		}
		if (event.type === "turn_end") {
			turnCount++;
			if (turnCount >= MAX_TURNS) {
				hitTurnLimit = true;
				session.abort();
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
				details: { error: String(err), activities, usage: { ...cumulativeUsage } },
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
			details: { aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, taskType, activities, usage: { ...cumulativeUsage } },
		};
	}

	let suffix = "";
	if (hitPermissionDenied) suffix += "\n[Subagent stopped: permission denied]";
	if (hitTurnLimit) suffix += `\n[Subagent hit turn limit (${MAX_TURNS})]`;
	if (hitTimeout) suffix += `\n[Subagent hit timeout (${effectiveTimeout / 1000}s)]`;

	return {
		content: [{ type: "text", text: fullText + suffix }],
		details: { taskType, aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, turnCount, activities, usage: { ...cumulativeUsage } },
	};
}
