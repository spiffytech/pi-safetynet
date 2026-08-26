/**
 * omp subagent spawning for safetynet — Phase 4.
 *
 * Provides a reviewer subagent via omp SDK createAgentSession: read-only
 * toolset (read/grep/glob), extension discovery disabled (prevents recursion
 * into this very extension), no MCP, provider-facing system prompt override.
 * Mirrors the SpawnOpts/SpawnResult seam pi-safetynet uses.
 */
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";
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
	cwd: string;
}

/** Spawn an isolated read-only session and return its final assistant text. */
export async function spawnReviewer(opts: OmpSpawnOpts): Promise<OmpSpawnResult> {
	const details: Record<string, unknown> = {};

	try {
		const { session } = await createAgentSession({
			cwd: opts.cwd,
			disableExtensionDiscovery: true,
			enableMCP: false,
			restrictToolNames: true,
			toolNames: ["read", "grep", "glob"],
			...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.timeoutMs ? { deadline: Date.now() + opts.timeoutMs } : {}),
			...(process.env.SAFENET_REVIEWER_MODEL
				? { modelPattern: process.env.SAFENET_REVIEWER_MODEL }
				: {}),
		});

		await session.prompt(opts.prompt);

		// Extract final assistant text from the session journal.
		const sm = session.sessionManager as unknown as SessionEntriesSource["sessionManager"];
		let text = "";
		for (const entry of sm.getEntries()) {
			if (entry.type !== "message") continue;
			const msg = entry.data as
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
	}
}
