/**
 * omp subagent spawning for safetynet — Phase 4.
 *
 * Provides a reviewer subagent via omp SDK createAgentSession: read-only
 * toolset (read/grep/glob), extension discovery disabled (prevents recursion
 * into this very extension), no MCP, provider-facing system prompt override.
 * Mirrors the SpawnOpts/SpawnResult seam pi-safetynet uses.
 */
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { SessionEntriesSource } from "./core/types.ts";

export interface OmpSpawnResult {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
}

export interface OmpSpawnOpts {
	taskType: "explore" | "build";
	prompt: string;
	systemPrompt?: string;
	timeoutMs?: number;
	/** External abort (e.g. our auto-review cap). Aborts the session on fire. */
	signal?: AbortSignal;
	cwd: string;
	/** Resolved reviewer model object (from the parent, where provider
	 *  extensions are loaded). Passing the object — not a deferred
	 *  modelPattern — lets the child session select it without loading
	 *  provider plugins itself. */
	model?: Model;
	/** Parent's model registry (carries provider auth). Forwarded like
	 *  omp's own task executor does for subagents. */
	modelRegistry?: ModelRegistry;
	/** Reviewer model pattern (provider/model or model id). Used only when
	 *  no resolved model object was provided. Falls back to
	 *  SAFENET_REVIEWER_MODEL env. */
	modelPattern?: string;
}

/** Spawn an isolated read-only session and return its final assistant text. */
export async function spawnReviewer(opts: OmpSpawnOpts): Promise<OmpSpawnResult> {
	const details: Record<string, unknown> = {};
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

	try {
		const created = await createAgentSession({
			// Isolation: without a unique agentId, omp defaults the reviewer to
			// MAIN_AGENT_ID — claiming the parent's registry identity, opening
			// the real on-disk session for cwd, and hijacking TUI focus. That
			// produced both the empty output (journal read from the parent's
			// session) and the locked-up prompt (keys routed to the reviewer).
			// This mirrors how omp's own task executor builds subagent sessions.
			cwd: opts.cwd,
			agentId: `safetynet-reviewer-${randomUUID()}`,
			agentDisplayName: "safetynet reviewer",
			sessionManager: SessionManager.inMemory(opts.cwd),
			hasUI: false,
			enableLsp: false,
			skipPythonPreflight: true,
			disableExtensionDiscovery: true,
			enableMCP: false,
			restrictToolNames: true,
			toolNames: ["read", "grep", "glob"],
			...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.timeoutMs ? { deadline: Date.now() + opts.timeoutMs } : {}),
			...(opts.model ? { model: opts.model } : {}),
			...(opts.modelRegistry ? { modelRegistry: opts.modelRegistry } : {}),
			// modelPattern only when no resolved model object is available.
			...(opts.model
				? {}
				: opts.modelPattern
					? { modelPattern: opts.modelPattern }
					: process.env.SAFENET_REVIEWER_MODEL
						? { modelPattern: process.env.SAFENET_REVIEWER_MODEL }
						: {}),
		});
		session = created.session;

		// Abort the reviewer session when the external cap signal fires (the
		// auto-review time budget in omp-pipeline). Otherwise a slow TTFT
		// would let the review outlive our 20s cap and keep burning tokens.
		const onAbort = () => {
			void session?.abort().catch(() => {});
		};
		if (opts.signal?.aborted) {
			onAbort();
			return { content: [{ type: "text", text: "" }], details: { aborted: true } };
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await session.prompt(opts.prompt);
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}

		// Extract final assistant text from the reviewer's OWN in-memory
		// session (entries live in `entry.message`, an AgentMessage).
		const sm = session.sessionManager as unknown as SessionEntriesSource["sessionManager"];
		let text = "";
		for (const entry of sm.getEntries()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: unknown }).message as
				| { role?: string; content?: string | Array<{ type: string; text?: string }> }
				| undefined;
			if (msg?.role !== "assistant") continue;
			if (typeof msg.content === "string") text = msg.content;
			else if (Array.isArray(msg.content)) {
				const t = msg.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("");
				if (t) text = t;
			}
		}

		return { content: [{ type: "text", text: text.trim() }], details };
	} catch (err) {
		details.error = err instanceof Error ? err.message : String(err);
		return { content: [{ type: "text", text: "" }], details };
	} finally {
		// Always dispose the isolated session so it can't leak LSP/registry
		// state back into the parent process (omp's executor does the same).
		if (session) {
			try {
				await session.dispose();
			} catch {
				// disposal is best-effort; ignore teardown errors
			}
		}
	}
}
