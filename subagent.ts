/**
 * Subagent orchestration — spawn in-process AgentSessions via the SDK.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	readOnlyTools,
	codingTools,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { Ruleset } from "./types.ts";
import type { PermissionStorage } from "./permissions/index.ts";
import { toDisplayPath } from "./project.ts";
import { createSubagentSafetynetExtension } from "./subagent-safetynet.ts";
import { writeFileSync, appendFileSync } from "node:fs";

// ── Diagnostic logging ──────────────────────────────────────────────────
const DEBUG_LOG = "/tmp/safetynet-subagent-debug.log";
let diagEnabled = false;

function diagLog(label: string, data: unknown): void {
	if (!diagEnabled) return;
	const ts = new Date().toISOString();
	const sep = "═".repeat(60);
	const entry = `\n${sep}\n[${ts}] ${label}\n${sep}\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`;
	appendFileSync(DEBUG_LOG, entry);
}

function diagClear(): void {
	if (!diagEnabled) return;
	writeFileSync(DEBUG_LOG, ``);
}

/** Diagnostic extension that logs provider payloads and context mutations. */
function createDiagnosticExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", async (event, _ctx) => {
			diagLog("session_start", { reason: (event as any).reason });
		});

		pi.on("resources_discover", async (event, _ctx) => {
			diagLog("resources_discover", { reason: event.reason });
		});

		pi.on("context", async (event, _ctx) => {
			const msgTypes = event.messages.map((m: any) => ({
				role: m.role,
				customType: (m as any).customType ?? undefined,
				contentType: m.content
					? (typeof m.content === "string"
						? "string"
						: Array.isArray(m.content)
							? m.content.map((c: any) => c.type).join(",")
							: typeof m.content)
					: "none",
				textPreview: typeof m.content === "string"
					? m.content.slice(0, 200)
					: Array.isArray(m.content)
						? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text?.slice(0, 200)).join(" | ")
						: undefined,
			}));
			diagLog("context messages", msgTypes);
		});

		pi.on("before_agent_start", async (event, _ctx) => {
			const e = event as any;
			diagLog("before_agent_start systemPrompt (first 2000 chars)", e.systemPrompt?.slice(0, 2000));
			diagLog("before_agent_start systemPromptOptions", {
				customPrompt: e.systemPromptOptions?.customPrompt?.slice(0, 500),
				selectedTools: e.systemPromptOptions?.selectedTools,
				toolSnippets: e.systemPromptOptions?.toolSnippets,
				promptGuidelines: e.systemPromptOptions?.promptGuidelines,
				appendSystemPrompt: e.systemPromptOptions?.appendSystemPrompt,
				cwd: e.systemPromptOptions?.cwd,
				contextFiles: e.systemPromptOptions?.contextFiles?.map((f: any) => f.path),
				skills: e.systemPromptOptions?.skills?.map((s: any) => s.name),
			});
		});

		pi.on("before_provider_request", async (event, _ctx) => {
			const payload = event.payload as Record<string, unknown>;
			diagLog("before_provider_request — full keys", Object.keys(payload ?? {}));
			diagLog("before_provider_request — model", payload?.model);

			// 1) Anthropic-style: separate top-level `system` field
			if (payload?.system) {
				const sys = payload.system;
				diagLog("before_provider_request — payload.system (anthropic-style)",
					typeof sys === "string" ? sys.slice(0, 10000) : JSON.stringify(sys, null, 2)?.slice(0, 10000));
			} else {
				diagLog("before_provider_request — payload.system", "(not present)");
			}

			// 2) OpenAI-style: system message inside messages[]
			const sysMsg = (payload?.messages as any[])?.find((m: any) => m.role === "system");
			diagLog("before_provider_request — system message in messages[]", sysMsg
				? { role: sysMsg.role, contentPreview: typeof sysMsg.content === "string" ? sysMsg.content.slice(0, 5000) : JSON.stringify(sysMsg.content)?.slice(0, 5000) }
				: "(no system message in messages[])");

			// 3) Search entire payload for "claude" / "Claude" (case-insensitive)
			const payloadStr = JSON.stringify(payload);
			const lower = payloadStr.toLowerCase();
			let searchFrom = 0;
			const claudeHits: string[] = [];
			while (true) {
				const idx = lower.indexOf("claude", searchFrom);
				if (idx < 0) break;
				claudeHits.push(payloadStr.slice(Math.max(0, idx - 80), idx + 80));
				searchFrom = idx + 6;
			}
			if (claudeHits.length) {
				diagLog(`before_provider_request — 'claude' found ${claudeHits.length} time(s) in full payload`, claudeHits);
			} else {
				diagLog("before_provider_request — 'claude' NOT found in full payload", "");
			}
		});
	};
}

export type SubagentTaskType = "explore" | "build";

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

	// Enable diagnostic logging — TEMPORARILY ALWAYS ON FOR DEBUGGING
	diagEnabled = true;
	diagClear();
	diagLog("runSubagent called", { taskType, cwd, model: opts.model ? `${(opts.model as any).provider}/${(opts.model as any).id}` : "(default)" });

	const modelRegistry = parentCtx.modelRegistry;

	const agentDir = process.env.PI_AGENT_DIR ?? `${process.env.HOME}/.pi/agent`;
	const settingsManager = SettingsManager.create(cwd, agentDir);
	settingsManager.setCompactionEnabled(false);

	const tools = taskType === "explore" ? readOnlyTools : codingTools;

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
			}),
			createDiagnosticExtension(),
		],
	};

	const loader = new DefaultResourceLoader(loaderOpts);
	await loader.reload();

	// Log ResourceLoader discoveries after reload (cast to any to access private fields)
	const loaderAny = loader as any;
	diagLog("ResourceLoader — systemPrompt (first 3000 chars)", loaderAny.systemPrompt?.slice(0, 3000));
	diagLog("ResourceLoader — appendSystemPrompt", loaderAny.appendSystemPrompt);
	diagLog("ResourceLoader — agentsFiles paths + content", loaderAny.agentsFiles?.map((f: any) => ({
		path: f.path,
		contentPreview: f.content?.slice(0, 500),
	})));
	diagLog("ResourceLoader — skills", loaderAny.skills?.map((s: any) => s.name));
	diagLog("ResourceLoader — prompts", loaderAny.prompts?.map((p: any) => p.name));

	const model = opts.model ?? parentCtx.model;
	if (!model) {
		return {
			content: [{ type: "text", text: "Error: No model available in parent context." }],
			details: { error: "no_model" },
		};
	}

	let result: CreateAgentSessionResult;
	try {
		result = await createAgentSession({
			cwd,
			model,
			tools,
			modelRegistry,
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

	diagLog("session.model after createAgentSession", {
		provider: (session as any).model?.provider,
		id: (session as any).model?.id,
		sentModel: { provider: (model as any)?.provider, id: (model as any)?.id },
	});

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

	diagLog("session.model after bindExtensions", {
		provider: (session as any).model?.provider,
		id: (session as any).model?.id,
	});

	let fullText = "";
	let turnCount = 0;
	let hitTurnLimit = false;
	let hitTimeout = false;
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

	const timeoutId = setTimeout(() => {
		hitTimeout = true;
		session.abort();
	}, TIMEOUT_MS);

	try {
		await session.prompt(prompt);
	} catch (err) {
		if (!aborted && !hitTurnLimit && !hitTimeout && !hitPermissionDenied) {
			return {
				content: [{ type: "text", text: `Subagent error: ${err}` }],
				details: { error: String(err), activities },
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
			details: { aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, taskType, activities },
		};
	}

	let suffix = "";
	if (hitPermissionDenied) suffix += "\n[Subagent stopped: permission denied]";
	if (hitTurnLimit) suffix += `\n[Subagent hit turn limit (${MAX_TURNS})]`;
	if (hitTimeout) suffix += `\n[Subagent hit timeout (${TIMEOUT_MS / 1000}s)]`;

	return {
		content: [{ type: "text", text: fullText + suffix }],
		details: { taskType, aborted, hitPermissionDenied, hitTurnLimit, hitTimeout, turnCount, activities },
	};
}
