/**
 * omp port of pi-safetynet — Phase 3.
 *
 * Wires omp's tool_call interception to the shared core/ checkers plus an
 * interactive askDialog-based permission pipeline, profile (plan/build/ro/rw)
 * state machine with journal persistence, and KV-cache-friendly ephemeral
 * mode-context injection via the context event.
 *
 * Not yet ported (Phase 4): LLM auto-approve reviewer, subagent bridging.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveOmpPermission, type OmpPipelineDeps } from "./omp-pipeline.ts";
import { PermissionStorage, reconstructSessionRules } from "./core/permissions/index.ts";
import {
	loadSubagentsConfig,
	loadTrustExternalPaths,
	loadDefaultProfile,
	loadParadigm,
	loadToggleModeKey,
} from "./core/global-config.ts";
import type { ProfileName, Ruleset } from "./core/types.ts";
import { checkBashPermission, checkFileTarget } from "./core/check.ts";
import {
	getCurrentProfile,
	setCurrentProfile,
	MODE_REMINDER_CUSTOM_TYPE,
	getModeSystemPrompt,
	getModeSwitchMessage,
	getSessionModeMessage,
	getParadigm,
	setParadigm,
	getModeAliases,
	normalizeProfile,
	isReadOnly,
	paradigmModes,
	persistProfile,
	restoreProfile,
} from "./core/profiles.ts";
import {
	isAutoEnabled,
	toggleAutoEnabled,
	restoreAutoEnabled,
	resetAutoEnabledForNewSession,
	setAutoEnabled,
	loadAutoApproveConfig,
} from "./core/auto-config-state.ts";
import { reviewBumpTurnToken } from "./core/reviewer-state.ts";
import { InferredEngine } from "./core/inferred/engine.ts";
import { uiArbiter } from "./core/ui-arbiter.ts";
import { JUDGE_SYSTEM_PROMPT } from "./core/inferred/judge.ts";
import { evaluatePermission } from "./core/permissions/ruleset.ts";
import { spawnReviewer } from "./omp-subagent.ts";
import { reviewerSpawnModelOpts } from "./omp-pipeline.ts";

const SESSION_RULES_CUSTOM_TYPE = "safetynet:session-rules";

export default function safetynetOmp(pi: ExtensionAPI) {
	pi.setLabel("safetynet");

	let storage: PermissionStorage | undefined;
	let trustExternalPaths = false;
	let inferred: InferredEngine | undefined;

	function deps(ctx: ExtensionContext): OmpPipelineDeps | undefined {
		if (!storage) return undefined;
		return {
			storage,
			ctx,
			profile: getCurrentProfile(),
			trustExternalPaths,
			modeAliases: getModeAliases(),
			...(inferred ? { inferred: wireInferred(ctx) } : {}),
			appendSessionRules: (rules: Ruleset, cwd: string) => {
				pi.appendEntry(SESSION_RULES_CUSTOM_TYPE, { rules, cwd });
			},
		};
	}

	/** Bind the inferred engine to the live session context: judge spawn
	 *  adapter (reviewer model chain), suppression predicate (existing rules
	 *  already allow an exemplar → don't offer), and UI hooks (badge widget
	 *  + toast; the review popup opens itself when a proposal ripens). */
	function wireInferred(ctx: ExtensionContext): InferredEngine {
		if (!inferred || !storage) return inferred!; // unreachable: caller guards
		const eng = inferred;
		inferred.judgeDeps = {
			ask: (prompt: string) => {
				// Same model chain the reviewer uses (autoApprove.model), resolved
				// against the parent catalog; degrade to the session model.
				const config = loadAutoApproveConfig();
				const first = Array.isArray(config.model) ? config.model[0] : config.model;
				return spawnReviewer({
					taskType: "explore",
					prompt,
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					cwd: ctx.cwd,
					timeoutMs: 30_000,
					...reviewerSpawnModelOpts(ctx, first ? { id: first } : undefined),
				}).then((r) => r.content.map((c) => c.text).join("\n"));
			},
		};
		inferred.suppressIfAllowed = (exemplar: string) =>
			evaluatePermission(
				"bash",
				exemplar,
				getCurrentProfile(),
				storage!.getAllRules(),
				undefined,
				getModeAliases(),
			).action === "allow";
		inferred.hooks = {
			onProposalQueued: (proposal) => {
				const n = inferred!.listProposals().length;
				ctx.ui.setWidget(
					"safetynet-inferred",
					[`${n} inferred-rule proposal${n === 1 ? "" : "s"} waiting — /safetynet:inferred to review`],
					{ placement: "belowEditor" },
				);
				ctx.ui.notify(`safetynet: inferred rule proposal — ${proposal.render}`, "info");
			},
			openReviewPopup: () => {
				// Fire-and-forget: owns input while up, Esc defers to the queue,
				// never gates the agent. Rendered by the popup module.
				import("./inferred-popup.ts").then((m) =>
					m.openInferredReview(ctx, inferred!, {
						modes: [getCurrentProfile()],
						onQueueChange: (n) => updateInferredBadge(ctx),
					}),
				).catch(() => {});
			},
		};
		return inferred;
	}

	function updateInferredBadge(ctx: ExtensionContext): void {
		const n = inferred?.listProposals().length ?? 0;
		if (n > 0) {
			ctx.ui.setWidget(
				"safetynet-inferred",
				[`${n} inferred-rule proposal${n === 1 ? "" : "s"} waiting — /safetynet:inferred to review`],
				{ placement: "belowEditor" },
			);
		} else {
			ctx.ui.setWidget("safetynet-inferred", undefined);
		}
	}

	function switchProfile(profile: ProfileName, ctx?: ExtensionContext) {
		const prev = getCurrentProfile();
		setCurrentProfile(normalizeProfile(profile));
		persistProfile(pi);
		// One durable mode message per actual switch — persisted, not ephemeral.
		if (prev !== getCurrentProfile()) {
			pi.sendMessage({
				customType: MODE_REMINDER_CUSTOM_TYPE,
				content: getModeSwitchMessage(getCurrentProfile()),
				display: false,
			});
		}
		ctx?.ui.notify(`safetynet: ${getCurrentProfile()} mode`, "info");
		if (ctx) {
			const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
			ctx.ui.setStatus("safetynet", label);
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		storage = new PermissionStorage(ctx.cwd);
		await storage.init();
		inferred = new InferredEngine(ctx.cwd);
		uiArbiter.reset(); // no stale surface may block a fresh session's prompts
		trustExternalPaths = loadTrustExternalPaths();
		setParadigm(loadParadigm());
		const def = loadDefaultProfile();
		if (def) setCurrentProfile(def);
		restoreProfile({ sessionManager: ctx.sessionManager });
		restoreAutoEnabled({ sessionManager: ctx.sessionManager });
		const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
		ctx.ui.setStatus("safetynet", label);

		// Session-start reminder (step 4): one durable message announcing the
		// opening mode. Omp's session_start has no reason field, so a fresh
		// session is detected by an empty journal.
		if (ctx.sessionManager.getEntries().length === 0) {
			pi.sendMessage({
				customType: MODE_REMINDER_CUSTOM_TYPE,
				content: getSessionModeMessage(getCurrentProfile()),
				display: false,
			});
		}
	});

	pi.on("session_shutdown", async () => {
		storage = undefined;
		inferred = undefined;
	});

	// Turn-scoped approvals expire when the agent finishes.
	pi.on("agent_end", async () => {
		storage?.temp.clearTurnRules();
		reviewBumpTurnToken(); // invalidate in-flight auto-review verdicts
	});

	// Review the pending inferred-rule queue (also reachable via widget hint).
	pi.registerCommand("safetynet:inferred", {
		description: "Review pending inferred-rule proposals",
		handler: async (_args, ctx) => {
			const eng = wireInferred(ctx);
			if (!eng) {
				ctx.ui.notify("safetynet: no session — nothing to review", "warning");
				return;
			}
			const { openInferredReview } = await import("./inferred-popup.ts");
			const result = await openInferredReview(ctx, eng, {
				modes: [getCurrentProfile()],
				onQueueChange: (n) => updateInferredBadge(ctx),
			});
			if (result === "empty") ctx.ui.notify("safetynet: no pending inferred-rule proposals", "info");
			else if (result === "busy") ctx.ui.notify("safetynet: another prompt is open — review when it closes", "warning");
			updateInferredBadge(ctx);
		},
	});

	// ── Session switches (/new, /resume, /fork, tree navigation) ─────────────
	// omp emits session_switch (not a fresh session_start) when /new creates a
	// session in-process, so module state must be reset or re-read here or it
	// leaks across sessions: profile, auto-approve, and in-memory session rules.
	pi.on("session_switch", async (event, ctx) => {
		if (!storage) return; // no session yet
		// Counters are session evidence — never leak across sessions.
		inferred = new InferredEngine(ctx.cwd);
		uiArbiter.reset();
		if (event.reason === "new") {
			// Brand-new session: reset to defaults.
			setCurrentProfile(normalizeProfile(loadDefaultProfile() ?? paradigmModes().read));
			resetAutoEnabledForNewSession();
			storage.session.clear();
			persistProfile(pi);
			pi.sendMessage({
				customType: MODE_REMINDER_CUSTOM_TYPE,
				content: getSessionModeMessage(getCurrentProfile()),
				display: false,
			});
		} else {
			// Resume/fork/tree: restore state from the target session's journal.
			restoreProfile(ctx);
			restoreAutoEnabled(ctx);
			const { rules } = reconstructSessionRules(ctx, ctx.cwd);
			storage.session.clear();
			if (rules.length > 0) storage.addSessionRules(rules);
		}
		const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
		ctx.ui.setStatus("safetynet", label);
	});
	// ── Auto-approve toggle ──────────────────────────────────────────────────

	pi.registerCommand("safetynet:auto", {
		description: "Toggle LLM auto-approval of low-risk actions",
		handler: async (_args, ctx) => {
			const r = toggleAutoEnabled(pi);
			if (r.blockedReason) ctx.ui.notify(`safetynet auto-approve unavailable: ${r.blockedReason}`, "warning");
			else ctx.ui.notify(`safetynet auto-approve: ${r.enabled ? "ON" : "OFF"}`, "info");
			const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
			ctx.ui.setStatus("safetynet", label);
		},
	});

	pi.registerShortcut("ctrl+shift+\\", {
		description: "Toggle LLM auto-approval of low-risk actions",
		handler: async (ctx) => {
			const r = toggleAutoEnabled(pi);
			if (r.blockedReason) ctx.ui.notify(`safetynet auto-approve unavailable: ${r.blockedReason}`, "warning");
			else ctx.ui.notify(`safetynet auto-approve: ${r.enabled ? "ON" : "OFF"}`, "info");
			const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
			ctx.ui.setStatus("safetynet", label);
		},
	});

	// ── Mode switching commands ──────────────────────────────────────────────

	for (const [cmd, profile] of [
		["safetynet:plan", "plan"],
		["safetynet:build", "build"],
		["safetynet:ro", "ro"],
		["safetynet:rw", "rw"],
	] as const) {
		pi.registerCommand(cmd, {
			description: `Switch to ${profile} mode`,
			handler: async (_args, ctx) => switchProfile(profile, ctx),
		});
	}

	pi.registerCommand("safetynet:mode", {
		description: "Show current safetynet mode",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`safetynet mode: ${getCurrentProfile()} (${getParadigm()})`, "info");
		},
	});

	// ── Mode toggle shortcut (default Ctrl-\, configurable via toggleModeKey) ─

	pi.registerShortcut(loadToggleModeKey() as "ctrl+\\", {
		description: "Toggle between read-only and read-write mode",
		handler: async (ctx) => {
			const { read, write } = paradigmModes();
			const next: ProfileName = getCurrentProfile() === read ? write : read;
			switchProfile(next, ctx);
		},
	});

	// ── Mode messaging: on-switch/start/compact only — no per-turn injection ──

	// Mode-specific permissions+subagents stanza appended to the system prompt
	// once per agent start, matching the CURRENT mode. Stable within a mode so
	// the provider-side KV prefix stays cached; switches are reflected on the
	// next turn plus a durable reminder (see switchProfile).
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: [...event.systemPrompt, getModeSystemPrompt(getCurrentProfile())] };
	});

	// Compaction purges history; re-append the current-mode reminder
	// unconditionally so the mode survives the purge.
	pi.on("session_compact", async () => {
		pi.sendMessage({
			customType: MODE_REMINDER_CUSTOM_TYPE,
			content: getSessionModeMessage(getCurrentProfile()),
			display: false,
		});
	});

	// ── Tool-call interception ───────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const handlerT0 = Date.now();
		if (!storage) return; // no session yet

		const profile = getCurrentProfile();
		const readOnly = isReadOnly(profile);

		// Read-only modes: deny file-mutating tools outright.
		if (readOnly && ["edit", "write"].includes(event.toolName)) {
			return {
				block: true,
				reason: `${profile === "ro" ? "Read-only" : "Plan"} mode: ${event.toolName} tool unavailable. The user can switch to ${paradigmModes().write} mode.`,
			};
		}

		const d = deps(ctx);
		if (!d) return;

		// ── bash ─────────────────────────────────────────────────────────────
		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!command) return;
			const runCheck = () => checkBashPermission(command, profile, storage!.getAllRules(), ctx.cwd, trustExternalPaths, getModeAliases(), inferred?.rulesForProfile(profile, getModeAliases()));
			const resolved = await resolveOmpPermission(d, {
				permission: "bash",
				target: command,
				check: runCheck(),
				recheck: runCheck,
			});
			console.warn(`safetynet: bash resolve=${Date.now() - handlerT0}ms since-handler-entry`);
			return resolved;
		}

		// ── read / glob / grep / edit / write ───────────────────────────────
		// glob and grep are read-only search tools: they never mutate files,
		// so they classify as "read" — not the generic fallback to "edit".
		const perm =
			event.toolName === "edit" || event.toolName === "write"
				? "edit"
				: event.toolName === "read" || event.toolName === "glob" || event.toolName === "grep"
					? "read"
					: undefined;
		if (!perm) return; // not a file tool we gate
		const input = event.input as Record<string, unknown>;
		const paths: string[] = [];
		if (typeof input.path === "string") paths.push(input.path);
		if (Array.isArray(input.paths)) {
			for (const p of input.paths) if (typeof p === "string") paths.push(p);
		}
		if (paths.length === 0) return;

		const runCheck = () => {
			// Worst action across all targets.
			let worst: ReturnType<typeof checkFileTarget> = { action: "allow" };
			for (const path of paths) {
				const r = checkFileTarget(path, perm, profile, storage!.getAllRules(), ctx.cwd, trustExternalPaths, getModeAliases());
				if (r.action === "deny") return { ...r, unapproved: [], redirectTargets: [] };
				if (r.action === "ask") worst = { action: "ask" };
			}
			return worst;
		};

		const resolved = await resolveOmpPermission(d, {
			permission: perm,
			target: paths[0]!,
			check: runCheck(),
			recheck: runCheck,
		});
		return resolved;
	});
}
