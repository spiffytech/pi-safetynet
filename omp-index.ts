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
import type { ProfileName, Ruleset } from "./core/types.ts";
import { PermissionStorage } from "./core/permissions/index.ts";
import {
	loadSubagentsConfig,
	loadTrustExternalPaths,
	loadDefaultProfile,
	loadParadigm,
	loadToggleModeKey,
} from "./core/global-config.ts";
import { checkBashPermission, checkFileTarget } from "./core/check.ts";
import {
	getCurrentProfile,
	setCurrentProfile,
	getParadigm,
	setParadigm,
	getModeAliases,
	normalizeProfile,
	isReadOnly,
	paradigmModes,
	persistProfile,
	restoreProfile,
	getEphemeralContextMessage,
	EPHEMERAL_CUSTOM_TYPE,
} from "./core/profiles.ts";
import { resolveOmpPermission, type OmpPipelineDeps } from "./omp-pipeline.ts";
import {
	isAutoEnabled,
	toggleAutoEnabled,
	restoreAutoEnabled,
	resetAutoEnabledForNewSession,
	setAutoEnabled,
} from "./core/auto-config-state.ts";
import { reviewBumpTurnToken } from "./core/reviewer-state.ts";

const SESSION_RULES_CUSTOM_TYPE = "safetynet:session-rules";

export default function safetynetOmp(pi: ExtensionAPI) {
	pi.setLabel("safetynet");

	let storage: PermissionStorage | undefined;
	let trustExternalPaths = false;

	function deps(ctx: ExtensionContext): OmpPipelineDeps | undefined {
		if (!storage) return undefined;
		return {
			storage,
			ctx,
			profile: getCurrentProfile(),
			trustExternalPaths,
			modeAliases: getModeAliases(),
			appendSessionRules: (rules: Ruleset, cwd: string) => {
				pi.appendEntry(SESSION_RULES_CUSTOM_TYPE, { rules, cwd });
			},
			signalBlocked: (active: boolean, label?: string) => {
				pi.events.emit("herdr:blocked", { active, label });
			},
		};
	}

	function switchProfile(profile: ProfileName, ctx?: ExtensionContext) {
		setCurrentProfile(normalizeProfile(profile));
		persistProfile(pi);
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
		trustExternalPaths = loadTrustExternalPaths();
		setParadigm(loadParadigm());
		const def = loadDefaultProfile();
		if (def) setCurrentProfile(def);
		restoreProfile({ sessionManager: ctx.sessionManager });
		restoreAutoEnabled({ sessionManager: ctx.sessionManager });
		const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
		ctx.ui.setStatus("safetynet", label);
	});

	pi.on("session_shutdown", async () => {
		storage = undefined;
	});

	// Turn-scoped approvals expire when the agent finishes.
	pi.on("agent_end", async () => {
		storage?.temp.clearTurnRules();
		reviewBumpTurnToken(); // invalidate in-flight auto-review verdicts
	});

	// ── Auto-approve toggle ──────────────────────────────────────────────────

	pi.registerCommand("safetynet:auto", {
		description: "Toggle LLM auto-approval of low-risk actions",
		handler: async (_args, ctx) => {
			const on = toggleAutoEnabled(pi);
			ctx.ui.notify(`safetynet auto-approve: ${on ? "ON" : "OFF"}`, "info");
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

	pi.registerShortcut("ctrl+shift+\\", {
		description: "Toggle LLM auto-approval of low-risk actions",
		handler: async (ctx) => {
			const on = toggleAutoEnabled(pi);
			ctx.ui.notify(`safetynet auto-approve: ${on ? "ON" : "OFF"}`, "info");
			const label = isAutoEnabled() ? `${getCurrentProfile()} auto` : getCurrentProfile();
			ctx.ui.setStatus("safetynet", label);
		},
	});

	// ── Ephemeral mode context (KV-cache-friendly suffix swap) ──────────────

	pi.on("context", async (event) => {
		const messages = event.messages as Array<{ customType?: string }>;
		const filtered = messages.filter((m) => m.customType !== EPHEMERAL_CUSTOM_TYPE);
		filtered.push({
			customType: EPHEMERAL_CUSTOM_TYPE,
			content: getEphemeralContextMessage(getCurrentProfile()),
			display: false,
			timestamp: Date.now(),
		} as never);
		return { messages: filtered as typeof event.messages };
	});

	// ── Tool-call interception ───────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
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
			const runCheck = () => checkBashPermission(command, profile, storage!.getAllRules(), ctx.cwd, trustExternalPaths, getModeAliases());
			const resolved = await resolveOmpPermission(d, {
				permission: "bash",
				target: command,
				check: runCheck(),
				recheck: runCheck,
			});
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
