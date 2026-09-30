/**
 * host-api.ts — the cooperation contract between pi-safetynet and pi-submarine.
 *
 * pi loads every extension entrypoint (and every package) in its own module
 * graph: module state never crosses between them. Anything live therefore
 * travels through `pi.events` (pi's documented extension-to-extension channel:
 * one shared event bus per load cycle, live object references).
 *
 * This module is pure: types, channel constants, and the handshake helper.
 * Each side imports its own copy; the handshake keeps load order irrelevant.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal shape of `pi.events` exchanged between extensions. */
export interface ExtensionEventsLike {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: any) => void): () => void;
}

/** A child tool call, as the gate sees it. */
export interface ChildGateRequest {
	toolName: string;
	input: Record<string, unknown>;
	/** The CHILD session's extension context (notifications, abort signal). */
	ctx: ExtensionContext;
}

/** `{ block, reason }` to refuse the call, `undefined` to allow it. */
export type ChildVerdict = { block: boolean; reason: string } | undefined;

/** Everything the session factory can vary per child session. */
export interface ChildServicesDeps {
	taskType: "explore" | "build";
	cwd: string;
	/** Parent session context — permission prompts display here. */
	parentCtx: ExtensionContext;
	trustExternalPaths: boolean;
	/** Active paradigm ("plan-build" | "ro-rw" by convention). */
	paradigm: string;
	/** Mode-name aliasing for rule matching, if the host has any. */
	modeAliases: Record<string, string>;
	/** Called when the user rejects something: the child aborts. */
	onPermissionDenied: () => void;
	/** Post a message into the CHILD session's transcript. */
	sendToChild: (msg: { customType: string; content: string; display: boolean }) => void;
}

/**
 * Permission enforcement for one child session, provided by the host.
 * pi-safetynet supplies its ruleset engine (shared approvals, prompts,
 * auto-deny); pi-submarine standalone supplies a simple confirm policy.
 */
export interface ChildServices {
	/** Gate one child tool call. Throw or return `{ block: true }` to refuse. */
	gate(req: ChildGateRequest): Promise<ChildVerdict>;
	/** Sensitive-file guard for explore children. Defaults to the pure matcher. */
	isSensitivePath?(path: string): boolean;
	/** Extra child tools the host wants (e.g. the reviewer's research tool). */
	registerChildTools?(pi: ExtensionAPI): void;
	/** Called on the child's `agent_end` — reset per-turn gate state (strikes). */
	onTurnEnd?(): void;
}

/** Built per child session, so per-child state (e.g. deny-strike counters) lives in the closure. */
export type ChildServicesFactory = (deps: ChildServicesDeps) => ChildServices;

/**
 * What pi-submarine consumes from pi-safetynet when both are installed.
 * Mode/config getters reflect the parent session's live state.
 */
export interface SafetynetHost {
	getProfile(): string;
	getParadigm(): string;
	getModeAliases(): Record<string, string>;
	trustExternalPaths(): boolean;
	/** Enforcement for build children (shared rules, approvals, prompts). */
	childServices: ChildServicesFactory;
	/** Marker for consumers; useful in diagnostics. */
	readonly kind: "safetynet";
}

/** Channel carrying the live host object (publisher → consumer). */
export const SAFETYNET_HOST_CHANNEL = "safetynet-host/v1";
/** Channel a consumer pings so an already-loaded publisher (re)announces. */
export const SAFETYNET_HOST_REQUEST_CHANNEL = "safetynet-host-request/v1";

/**
 * Publish the host: announce immediately (a consumer may already be listening)
 * and answer every later request. Returns the unsubscriber.
 */
export function publishSafetynetHost(events: ExtensionEventsLike, host: SafetynetHost): () => void {
	const announce = () => events.emit(SAFETYNET_HOST_CHANNEL, host);
	const off = events.on(SAFETYNET_HOST_REQUEST_CHANNEL, announce);
	announce();
	return () => {
		try {
			off();
		} catch {
			/* runtime already torn down */
		}
	};
}

/**
 * Find the host: subscribe, then request an announcement. Works regardless of
 * which side loaded first. `refresh` re-requests (e.g. after /reload).
 */
export function requestSafetynetHost(
	events: ExtensionEventsLike,
	onHost: (host: SafetynetHost) => void,
): { dispose: () => void; refresh: () => void } {
	const off = events.on(SAFETYNET_HOST_CHANNEL, onHost);
	const request = () => events.emit(SAFETYNET_HOST_REQUEST_CHANNEL, {});
	request();
	return {
		dispose: () => {
			try {
				off();
			} catch {
				/* runtime already torn down */
			}
		},
		refresh: request,
	};
}