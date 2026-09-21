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
import { debugLog } from "./core/debug-log.ts";

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
	 *  SAFETYNET_REVIEWER_MODEL env. */
	modelPattern?: string;
}

/** The live session handle returned by `createAgentSession`. Named here so
 *  spawnReviewer's local doesn't couple to SDK implementation generics. */
export interface ReviewerSession {
	abort(options?: { reason?: string }): Promise<void>;
	prompt(text: string): Promise<boolean>;
	dispose(): Promise<void> | void;
	sessionManager: SessionEntriesSource["sessionManager"];
}

/** Preloaded discovery pass-throughs for the reviewer session. The reviewer
 *  needs read/grep/glob plus the injected review prompt — nothing discovered
 *  from disk. Empty arrays skip the FS walks (TTSR rule compilation, skills
 *  scan, AGENTS.md walk, prompt-template discovery) that dominated boot cost
 *  when a review ran inside the parent's 30s tool_call budget. The
 *  workspaceTree stub matches the SDK's own empty-scan sentinel shape. */
const REVIEWER_SESSION_PRELOADS = {
	rules: [],
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	slashCommands: [],
	workspaceTree: { rootPath: "", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
};

export async function spawnReviewer(opts: OmpSpawnOpts): Promise<OmpSpawnResult> {
	const details: Record<string, unknown> = {};
	const reviewerT0 = Date.now();
	let bootMs = 0;
	let session: ReviewerSession | undefined;

	try {
		// Abort the reviewer session when the external cap signal fires (the
		// auto-review time budget in omp-pipeline). Otherwise a slow TTFT
		// would let the review outlive our 20s cap and keep burning tokens.
		const onAbort = () => {
			void session?.abort().catch(() => {});
		};

		// The cap can fire while `createAgentSession` is still in flight
		// (cold-boot discovery, hydrate, skills scanning). Race the boot
		// against the signal so a slow boot is actually cancelled instead
		// of silently running to completion and wasting the budget.
		const bootPromise = createAgentSession({
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
			...REVIEWER_SESSION_PRELOADS,
			workspaceTree: { ...REVIEWER_SESSION_PRELOADS.workspaceTree, rootPath: opts.cwd },
			...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.timeoutMs ? { deadline: Date.now() + opts.timeoutMs } : {}),
			...(opts.model ? { model: opts.model } : {}),
			...(opts.modelRegistry ? { modelRegistry: opts.modelRegistry } : {}),
			// modelPattern only when no resolved model object is available.
			...(opts.model
				? {}
				: opts.modelPattern
					? { modelPattern: opts.modelPattern }
					: process.env.SAFETYNET_REVIEWER_MODEL
						? { modelPattern: process.env.SAFETYNET_REVIEWER_MODEL }
						: {}),
		});
		const created = opts.signal
			? await Promise.race([
					bootPromise,
					new Promise<never>((_, reject) => {
						opts.signal!.addEventListener("abort", () => {
							// The boot may still be in flight; dispose the session it
							// eventually creates so it can't leak registry/LLM state.
							void bootPromise
								.then((lost) => lost.session.dispose().catch(() => {}))
								.catch(() => {});
							reject(new DOMException("Auto-review exceeded time budget", "TimeoutError"));
						}, { once: true });
					}),
				])
			: await bootPromise;
		session = created.session;
		bootMs = Date.now() - reviewerT0;
		if (opts.signal?.aborted) {
			return { content: [{ type: "text", text: "" }], details: { aborted: true } };
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await session.prompt(opts.prompt);
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}
		const promptMs = Date.now() - reviewerT0 - bootMs;
		details.bootMs = bootMs;
		details.promptMs = promptMs;
		// Phase timings land in the omp debug log; correlated against
		// ui.loop-blocked entries when a review stalls the UI.
		if (promptMs > 3000) {
			debugLog(`safetynet: reviewer slow — boot=${bootMs}ms prompt=${promptMs}ms total=${Date.now() - reviewerT0}ms`);
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
