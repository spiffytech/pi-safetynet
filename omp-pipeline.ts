/**
 * omp permission-resolution pipeline: mirrors pi-safetynet's resolvePermission
 * loop semantics (allow/deny short-circuits, interactive prompt, rule creation
 * at chosen scope, recheck) against ctx.ui.askDialog. Auto-review and
 * hazardous nudge-and-abort arrive with Phase 4.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	ModeAliases,
	PermissionDuration,
	ProfileName,
	Rule,
	Ruleset,
	TempRule,
} from "./core/types.ts";
import { PermissionStorage } from "./core/permissions/index.ts";
import { normalizePathForMatching, toRecursiveGlob } from "./core/project.ts";
import type { PermissionCheck } from "./core/check.ts";
import { showOmpPermissionPrompt } from "./omp-permission-prompt.ts";
import { spawnReviewer } from "./omp-subagent.ts";

/** Hard cap on one auto-review attempt. The reviewer runs inside the
 *  tool_call handler, which omp bounds at extensionHandlers.toolCallTimeoutMs
 *  (default 30s, fail-closed on expiry). We race it ourselves at a lower
 *  bound so a slow first-token degrades to the interactive prompt instead
 *  of omp silently blocking the tool call with a timeout error. */
const AUTO_REVIEW_CAP_MS = 20_000;

/** Resolve the reviewer model in the parent session (where provider
 *  extensions like hyper are loaded and authenticated) so the child
 *  session can select it via the resolved Model object instead of a
 *  deferred modelPattern that fails without provider plugins loaded.
 *  Returns an object fit for spreading into OmpSpawnOpts. */
function resolveReviewerModel(
	ctx: ExtensionContext,
	configModel?: string,
): { model?: unknown; modelRegistry?: unknown; modelPattern?: string } {
	const spec = configModel ?? process.env.SAFENET_REVIEWER_MODEL;
	if (spec) {
		const resolved = ctx.models.resolve(spec);
		if (resolved) {
			return { model: resolved, modelRegistry: ctx.modelRegistry };
		}
	}
	return spec ? { modelPattern: spec } : {};
}
import {
	runPermissionReview,
	reviewIsActive,
	reviewSetActive,
	reviewTurnToken,
	reviewIncrementDenies,
	reviewResetDenies,
} from "./core/reviewer-state.ts";
import { loadAutoApproveConfig, isAutoEnabled } from "./core/auto-config-state.ts";

export interface OmpPipelineDeps {
	storage: PermissionStorage;
	ctx: ExtensionContext;
	profile: ProfileName;
	trustExternalPaths: boolean;
	modeAliases: ModeAliases;
	/** Persist session-scoped rules as a journal entry for resume reconstruction. */
	appendSessionRules?: (rules: Ruleset, cwd: string) => void;
	/** Signal blocked/active state to external watchers (herdr). Emitted
	 *  with `{ active, label }` on the `herdr:blocked` event-bus channel. */
	signalBlocked?: (active: boolean, label?: string) => void;
}

export interface ResolveOpts {
	permission: "bash" | "read" | "edit";
	target: string;
	check: PermissionCheck;
	recheck: () => PermissionCheck;
}

function makeTempRule(permission: "bash" | "read" | "edit", pattern: string, modes: ProfileName[]): TempRule {
	return { rule: { permission, pattern, action: "allow", modes }, expiry: { type: "turn" } };
}

/** Turn-scoped rules for an auto-review allow verdict. Mirrors pi's
 *  buildApprovalRules: one bash rule per unapproved subcommand, one read/edit
 *  rule per redirect target, else the file itself for plain file tool calls. */
function buildApprovalTempRules(
	permission: "bash" | "read" | "edit",
	check: PermissionCheck,
	target: string,
	cwd: string,
	modes: ProfileName[],
): TempRule[] {
	const rules: TempRule[] = [];
	for (const sub of check.unapproved ?? []) {
		rules.push(makeTempRule(permission, sub, modes));
	}
	for (const rt of check.redirectTargets ?? []) {
		rules.push(makeTempRule(rt.permission, toRecursiveGlob(normalizePathForMatching(rt.path, cwd)), modes));
	}
	if (rules.length === 0 && (permission === "read" || permission === "edit")) {
		rules.push(makeTempRule(permission, toRecursiveGlob(normalizePathForMatching(target, cwd)), modes));
	}
	return rules;
}

export async function resolveOmpPermission(
	deps: OmpPipelineDeps,
	opts: ResolveOpts,
): Promise<{ block: boolean; reason: string } | undefined> {
	let check = opts.check;
	let reprompt = false;

	for (;;) {
		const { action } = check;

		if (action === "allow") return undefined;

		if (action === "deny") {
			const label = opts.permission[0]!.toUpperCase() + opts.permission.slice(1);
			const reason =
				check.reason ?? `${label} denied: no matching allow rule`;
			return { block: true, reason };
		}

		// ── ask ──────────────────────────────────────────────────────────────

		// Auto-review: a read-only reviewer subagent judges the action against
		// the risk policy before we bother the user. Circuit-breaker state and
		// verdict classification live in core/reviewer-state.ts.
		if (isAutoEnabled() && !reviewIsActive()) {
			const config = loadAutoApproveConfig();
			const token = reviewTurnToken();
			reviewSetActive(true);
			const capController = new AbortController();
			let capped = false;
			const capTimer = setTimeout(() => {
				capped = true;
				capController.abort(new DOMException("Auto-review exceeded time budget", "TimeoutError"));
			}, AUTO_REVIEW_CAP_MS);
			try {
				const verdict = await runPermissionReview(
					{
						permission: opts.permission,
						target: opts.target,
						check,
						cwd: deps.ctx.cwd,
						parentCtx: { sessionManager: deps.ctx.sessionManager },
						profile: deps.profile,
						timeoutMs: config.timeoutMs ?? 90000,
						signal: capController.signal,
					},
					{ spawn: (o) =>
						spawnReviewer({
							...o,
							cwd: deps.ctx.cwd,
							...(o.signal ? { signal: o.signal } : {}),
							...resolveReviewerModel(deps.ctx, config.model),
						}) },
				);
				// Discard stale verdicts (their turn already ended).
				if (token === reviewTurnToken() && verdict.kind === "assessment") {
					if (verdict.assessment.outcome === "allow") {
						reviewResetDenies();
						// Turn-scoped rules so the approval dies with the turn.
						const tempRules = buildApprovalTempRules(opts.permission, check, opts.target, deps.ctx.cwd, [deps.profile]);
						deps.storage.addTempRules(tempRules);
						const recheckResult = opts.recheck();
						if (recheckResult.action === "allow") return undefined;
					} else if (verdict.assessment.outcome === "deny") {
						const count = reviewIncrementDenies();
						const maxDenials = config.maxDenials ?? 3;
						if (count >= maxDenials) {
							return { block: true, reason: `Auto-review denied ${count} consecutive actions; disabling auto-approve for this session.` };
						}
						return { block: true, reason: `Auto-review denied: ${verdict.assessment.rationale}` };
					}
				}
				// stale / transient / fatal → fall through to the interactive prompt.
				// Surface WHY auto-review didn't approve so it doesn look dead.
				if (capped) {
					deps.ctx.ui.notify("safetynet auto-review exceeded its time budget; asking you instead.", "warning");
				} else if (verdict.kind !== "assessment") {
					deps.ctx.ui.notify(`safetynet auto-review unavailable (${verdict.kind}: ${verdict.message}); asking you instead.`, "warning");
				} else if (token !== reviewTurnToken()) {
					deps.ctx.ui.notify("safetynet auto-review verdict arrived after turn end; discarded.", "warning");
				}
			} finally {
				clearTimeout(capTimer);
				reviewSetActive(false);
			}
		}

		const isFile = opts.permission !== "bash";
		const canonical: string[] = [];
		const display: string[] = [];

		if (!isFile) {
			for (let i = 0; i < (check.unapproved?.length ?? 0); i++) {
				canonical.push(check.unapproved![i]!);
				display.push(check.unapprovedDisplay?.[i] ?? check.unapproved![i]!);
			}
			for (const rt of check.redirectTargets ?? []) {
				canonical.push(rt.path);
				display.push(`${rt.permission}: ${rt.path}`);
			}
		} else {
			canonical.push(opts.target);
			display.push(opts.target);
		}

		deps.signalBlocked?.(true, `safetynet ${opts.permission} approval`);
		let result: Awaited<ReturnType<typeof showOmpPermissionPrompt>>;
		try {
			result = await showOmpPermissionPrompt(deps.ctx, {
				permission: opts.permission,
				target: opts.target,
				unapproved: canonical,
				unapprovedDisplay: display,
				...(check.reason ? { reason: check.reason } : {}),
				...(reprompt ? { reprompt: true } : {}),
				keybindings: { denyAbort: "escape" },
			});
		} finally {
			deps.signalBlocked?.(false);
		}

		if (!result) {
			// Esc / abort → deny and end the turn.
			deps.ctx.abort();
			return { block: true, reason: `User denied ${opts.permission}` };
		}

		if (result.kind === "deny") {
			const reason = result.explanation
				? `User denied ${opts.permission}: ${result.explanation}`
				: `User denied ${opts.permission}`;
			return { block: true, reason };
		}

		const { approved, skipped, skippedDisplay, duration } = result;

		// "once" — approve this invocation only; if some items were skipped,
		// narrow the check to them and re-prompt.
		if (duration === "once") {
			const skippedItems = skipped.length > 0 ? skipped : canonical.filter((c) => !approved.has(c));
			if (skippedItems.length > 0) {
				check = {
					...check,
					unapproved: skippedItems.filter((s) => !(check.redirectTargets ?? []).some((rt) => rt.path === s)),
					unapprovedDisplay: skippedItems.map((s) => display[canonical.indexOf(s)] ?? s),
					action: "ask",
					redirectTargets: (check.redirectTargets ?? []).filter((rt) => skippedItems.includes(rt.path)),
				};
				continue;
			}
			return undefined;
		}

		// Build rules from approved items (mirrors pi pipeline semantics).
		const redirectOriginals = new Set((check.redirectTargets ?? []).map((rt) => rt.path));
		const patterns: Array<{ permission: "bash" | "read" | "edit"; pattern: string }> = [];
		for (const [original] of approved) {
			if (redirectOriginals.has(original)) continue;
			patterns.push({
				permission: opts.permission,
				pattern: isFile ? toRecursiveGlob(normalizePathForMatching(original, deps.ctx.cwd)) : original,
			});
		}
		for (const rt of check.redirectTargets ?? []) {
			if (approved.has(rt.path)) {
				patterns.push({
					permission: rt.permission,
					pattern: toRecursiveGlob(normalizePathForMatching(rt.path, deps.ctx.cwd)),
				});
			}
		}
		void duration; // scope handled below

		const newRules: Ruleset = patterns.map(
			(p): Rule => ({ permission: p.permission, pattern: p.pattern, action: "allow", modes: [deps.profile] }),
		);
		const tempRules: TempRule[] = patterns.map((p) => makeTempRule(p.permission, p.pattern, [deps.profile]));

		if (duration === "turn") {
			deps.storage.addTempRules(tempRules);
		} else if (duration === "session") {
			deps.storage.addSessionRules(newRules);
			deps.appendSessionRules?.(newRules, deps.ctx.cwd);
		} else if (duration === "project") {
			await deps.storage.addPersistedRules(newRules);
		} else if (duration === "global") {
			await deps.storage.addGlobalRules(newRules);
		}

		// Recheck after rule creation.
		check = opts.recheck();
		if (check.action === "allow") return undefined;
		if (check.action === "deny") {
			deps.ctx.ui.notify("Rule(s) added but still denied.", "warning");
			return { block: true, reason: "Still denied after rule update" };
		}
		// still ask → loop back into the prompt, flagging the reprompt.
		reprompt = true;
	}
}

/** Convenience wrapper: run a checker and resolve through the full pipeline.
 *  Returns undefined when approved (tool should run), or block/reason. */
export async function checkAndResolve(
	deps: OmpPipelineDeps,
	opts: {
		permission: "bash" | "read" | "edit";
		runCheck: () => PermissionCheck;
		recheck: () => PermissionCheck;
	},
): Promise<{ block: boolean; reason: string } | undefined> {
	const check = opts.runCheck();
	return resolveOmpPermission(deps, { permission: opts.permission, target: "", check, recheck: opts.recheck });
}
