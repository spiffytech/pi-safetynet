/**
 * subagent-runner.ts — persistent (multi-segment) subagent session runner.
 *
 * Uses the shared `createSubagentSession` helper, so it differs from the
 * one-shot reviewer path only in lifecycle: it keeps the AgentSession alive
 * across work segments, exposes controls, and reports bash output/usage.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { createSubagentSession, type ChildServicesFactory, type JobWatchApi, type ReportingOptions } from "pi-submarine-core";
import type { JobControls } from "./subagent-jobs.ts";

export interface PersistentSubagentOptions {
	jobId: string;
	taskType: "explore" | "build";
	parentCtx: ExtensionContext;
	cwd: string;
	model?: Model<any> | undefined;
	thinkingLevel?: string | undefined;
	trustExternalPaths?: boolean;
	paradigm?: string;
	modeAliases?: Record<string, string>;
	/** Permission enforcement for the child (SafetynetHost's factory, or the
	 *  standalone policy). Required for build task types. */
	services?: ChildServicesFactory | undefined;
	reporting?: ReportingOptions;
	/** Watch registration surface exposed to the child (`job_watch` — same tool the parent gets). */
	watches?: JobWatchApi | undefined;
	/** Invoked once the child session exists and controls are live. */
	onControls(controls: JobControls): void;
	/** Latest bash call output (command + tail). Replaces, never accumulates. */
	onBashOutput(command: string, tail: string): void;
	onUsage(usage: Usage): void;
	/** Segment ended: "completed" naturally, or "timeout" when the segment cap
	 *  aborted it mid-command (surfaced to the parent, never as plain idle). */
	onIdle(reason: { kind: "completed" | "timeout"; command?: string; durationMs?: number }): void;
	onError(error: string): void;
	/** Polled around session creation so a job closed mid-start never orphans a session. */
	isClosed?(): boolean;
	/** Per-segment wall-clock cap; aborts the session on expiry. */
	segmentTimeoutMs?: number;
}

export interface PersistentSubagentHandle {
	dispose(): void;
}

const SEGMENT_TIMEOUT_MS = 300_000;

/** Test/live-fast override for the segment cap (PI_SUBMARINE_SEGMENT_TIMEOUT_MS, ms). */
function segmentTimeoutDefault(): number {
	const raw = process.env.PI_SUBMARINE_SEGMENT_TIMEOUT_MS;
	const n = raw ? Number(raw) : NaN;
	return Number.isFinite(n) && n > 0 ? n : SEGMENT_TIMEOUT_MS;
}

function formatBashTail(partial: unknown): string {
	const content = (partial as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") return part.text;
	}
	return "";
}

/**
 * Start a persistent subagent. Drives the session in the background and reports
 * lifecycle through the callbacks. `dispose()` aborts and tears it down.
 */
export function startPersistentSubagent(opts: PersistentSubagentOptions): PersistentSubagentHandle {
	let session: { abort(): void; dispose(): void } | undefined;
	let disposed = false;

	const dispose = () => {
		if (disposed) return;
		disposed = true;
		try {
			session?.abort();
		} catch {
			/* best effort */
		}
		try {
			session?.dispose();
		} catch {
			/* best effort */
		}
	};

	void (async () => {
		try {
			let permissionDenied = false;
			const created = await createSubagentSession({
				taskType: opts.taskType,
				cwd: opts.cwd,
				parentCtx: opts.parentCtx,
				...(opts.model !== undefined ? { model: opts.model } : {}),
				...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
				...(opts.trustExternalPaths !== undefined ? { trustExternalPaths: opts.trustExternalPaths } : {}),
				...(opts.paradigm !== undefined ? { paradigm: opts.paradigm } : {}),
				...(opts.modeAliases !== undefined ? { modeAliases: opts.modeAliases } : {}),
				...(opts.services !== undefined ? { services: opts.services } : {}),
				...(opts.reporting !== undefined ? { reporting: opts.reporting } : {}),
				...(opts.watches !== undefined ? { watches: opts.watches } : {}),
				compactionEnabled: true,
				onPermissionDenied: () => {
					permissionDenied = true;
				},
			});
			if (!created.ok) {
				opts.onError(created.message);
				return;
			}

			const child = created.session;
			session = child;
			if (disposed || opts.isClosed?.()) {
				child.dispose();
				return;
			}

			let currentBashCommand = "";
			// Prompts awaiting a real turn. A `subagent_send` while one is in flight
			// is a steer: pi queues it and returns immediately, so it must not be
			// treated as a finished segment — only the in-flight turn's own
			// resolution is a real segment end.
			let segmentsInFlight = 0;
			child.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "bash") {
					currentBashCommand = (event.args as { command?: string } | undefined)?.command ?? "";
					opts.onBashOutput(currentBashCommand, "");
				}
				if (event.type === "tool_execution_update" && event.toolName === "bash") {
					opts.onBashOutput(currentBashCommand, formatBashTail(event.partialResult));
				}
				if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage) {
					opts.onUsage(event.message.usage);
				}
			});

			const controls: JobControls = {
				prompt: async (text: string) => {
					if (disposed || permissionDenied) return;
					const isSteer = segmentsInFlight > 0;
					segmentsInFlight++;
					const timeoutMs = opts.segmentTimeoutMs ?? segmentTimeoutDefault();
					let abortedByTimeout = false;
					const timeoutId = setTimeout(() => {
						abortedByTimeout = true;
						try {
							child.abort();
						} catch {
							/* best effort */
						}
					}, timeoutMs);
					try {
						await child.prompt(text, { streamingBehavior: "steer" });
						if (!isSteer) {
							opts.onIdle(
								abortedByTimeout
									? { kind: "timeout", command: currentBashCommand, durationMs: timeoutMs }
									: { kind: "completed" },
							);
						}
					} catch (err) {
						opts.onError(String(err));
					} finally {
						clearTimeout(timeoutId);
						segmentsInFlight--;
					}
				},
				steer: async (text: string) => {
					if (disposed) return;
					await child.steer(text);
				},
				abort: dispose,
			};

			opts.onControls(controls);
		} catch (err) {
			opts.onError(String(err));
		}
	})();

	return { dispose };
}