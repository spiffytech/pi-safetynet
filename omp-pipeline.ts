/**
 * omp permission-resolution pipeline: mirrors pi-safetynet's resolvePermission
 * loop semantics (allow/deny short-circuits, interactive prompt, rule creation
 * at chosen scope, recheck) against ctx.ui.askDialog. Auto-review and
 * hazardous nudge-and-abort arrive with Phase 4.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
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
import { actionWrites } from "./core/check.ts";
import { isReadOnly } from "./core/profiles.ts";
import { showOmpPermissionPrompt } from "./omp-permission-prompt.ts";
import { spawnReviewer } from "./omp-subagent.ts";
import type { InferredEngine } from "./core/inferred/engine.ts";

/** Hard cap on one auto-review attempt. The reviewer runs inside the
 *  tool_call handler, which omp bounds at extensionHandlers.toolCallTimeoutMs
 *  (default 30s, fail-closed on expiry). We race it ourselves at a lower
 *  bound so a slow first-token degrades to the interactive prompt instead
 *  of omp silently blocking the tool call with a timeout error. */
const AUTO_REVIEW_CAP_MS = 20_000;

/** Translate a registry-resolved partial model (`{ id, provider }` — the
 *  shape core/reviewer-state hands down for the current chain spec) into the
 *  full Model object the isolated reviewer session needs: it disables
 *  extension discovery, so a bare id or deferred pattern cannot be
 *  re-resolved there and would boot the session model-less. Lookup order:
 *  full-catalog registry `find` first (covers models that are temporarily
 *  absent from the "available" set, e.g. after a failed runtime refresh),
 *  then the facade's provider/id and bare-id forms. Returns undefined when
 *  the spec is not in the parent catalog at all. */
export function resolveReviewerSpawnModel(
	ctx: ExtensionContext,
	partial: { id: string; provider?: string } | undefined,
): Model | undefined {
	if (!partial?.id) return undefined;
	if (partial.provider) {
		const found = ctx.modelRegistry.find(partial.provider, partial.id);
		if (found) return found;
	}
	const spec = partial.provider ? `${partial.provider}/${partial.id}` : partial.id;
	return ctx.models.resolve(spec) ?? ctx.models.resolve(partial.id);
}

/** Pick the spawn model for ONE review attempt. `partial` is the current
 *  chain spec resolved by core against the parent registry; translate it to
 *  a full Model. When it can't be resolved (spec absent from the catalog, e.g.
 *  stale cache after a rate-limited refresh), degrade to the parent session's
 *  own model — it is running, so it is guaranteed present — rather than a
 *  modelPattern the isolated child cannot resolve. Returns an object fit for
 *  spreading into OmpSpawnOpts. */
export function reviewerSpawnModelOpts(
	ctx: ExtensionContext,
	partial: { id: string; provider?: string } | undefined,
): { model?: Model; modelRegistry?: typeof ctx.modelRegistry } {
	const resolved =
		partial?.id ? resolveReviewerSpawnModel(ctx, partial) ?? ctx.model : ctx.model;
	if (!resolved) return {};
	return { model: resolved, modelRegistry: ctx.modelRegistry };
}
import {
	runPermissionReview,
	reviewIsActive,
	reviewSetActive,
	reviewTurnToken,
	reviewIncrementDenies,
	reviewResetDenies,
	reviewRecordLatency,
	reviewLatencyEma,
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
	/** Inferred-rules engine (bash shape counters → judge → proposal queue).
	 *  Optional; absent when the feature has no session to bind to. */
	inferred?: InferredEngine;
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

/** Sticky reviewer-health widget. Renders whenever the EMA has crossed the
 *  configured threshold; clears when the EMA recovers below it. The widget
 *  survives redraws because setWidget content is declarative. */
function updateLatencyWidget(deps: OmpPipelineDeps, emaMs: number, thresholdMs: number): void {
	const ui = deps.ctx.ui;
	if (emaMs > thresholdMs) {
		ui.setWidget(
			"safetynet-reviewer-latency",
			[`⚠ safetynet reviewer slow: EMA ${(emaMs / 1000).toFixed(1)}s > ${(thresholdMs / 1000).toFixed(1)}s budget (autoApprove.latencyWarnEmaMs)`],
			{ placement: "belowEditor" },
		);
	} else {
		ui.setWidget("safetynet-reviewer-latency", undefined);
	}
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
			// Read-only mode enforcement: reject mechanically-classifiable
			// writes outright — never hand a write to the reviewer, whose
			// allow would mint temp write rules in a read-only session.
			// Writes only the reviewer can spot (git commit, touch, mkdir)
			// are covered by the prompt's Session-mode rule.
			if (isReadOnly(deps.profile) && actionWrites(opts.permission, check)) {
				return {
					block: true,
					reason: `Mode denied ${opts.permission}: ${opts.target} — read-only mode prevents writes; switch to ${deps.profile === "ro" ? "rw" : "build"} mode to implement`,
				};
			}
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
				const reviewT0 = Date.now();
				// Full reviewer-model fallback chain: config list first, then the
				// SAFETYNET_REVIEWER_MODEL env override (lowest priority), deduped
				// order-preserving. core/reviewer-state tries each spec until one
				// produces a verdict, so a rate-limited or unresolvable first model
				// degrades to the next instead of failing the whole review.
				const modelSpecs = Array.isArray(config.model) ? [...config.model] : config.model ? [config.model] : [];
				const envModel = process.env.SAFETYNET_REVIEWER_MODEL?.trim();
				if (envModel && !modelSpecs.includes(envModel)) modelSpecs.push(envModel);
				const verdict = await runPermissionReview(
					{
						permission: opts.permission,
						target: opts.target,
						check,
						cwd: deps.ctx.cwd,
						parentCtx: { sessionManager: deps.ctx.sessionManager, modelRegistry: deps.ctx.modelRegistry },
						profile: isReadOnly(deps.profile) ? "ro" : "rw",
						timeoutMs: config.timeoutMs ?? 90000,
						signal: capController.signal,
						...(modelSpecs.length > 0 ? { model: modelSpecs } : {}),
					},
					{ spawn: (o) =>
						spawnReviewer({
							...o,
							cwd: deps.ctx.cwd,
							// `o.model` is core's registry-resolved partial for the CURRENT
							// chain spec; translate it to a full Model the isolated child
							// can use, falling back to the parent session's own model when
							// the spec isn't in the catalog at all.
							...reviewerSpawnModelOpts(deps.ctx, o.model),
							...(o.signal ? { signal: o.signal } : {}),
						}) },
				);
				updateLatencyWidget(deps, reviewRecordLatency(Date.now() - reviewT0), config.latencyWarnEmaMs ?? 8000);
				// Discard stale verdicts (their turn already ended).
				if (token === reviewTurnToken() && verdict.kind === "assessment") {
					if (verdict.assessment.outcome === "allow") {
						reviewResetDenies();
						// Turn-scoped rules so the approval dies with the turn.
						const tempRules = buildApprovalTempRules(opts.permission, check, opts.target, deps.ctx.cwd, [deps.profile]);
						deps.storage.addTempRules(tempRules);
						if (opts.permission === "bash") deps.inferred?.recordApproval(check.unapproved ?? [], [deps.profile]);
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

		const result = await showOmpPermissionPrompt(deps.ctx, {
			permission: opts.permission,
			target: opts.target,
			unapproved: canonical,
			unapprovedDisplay: display,
			...(check.reason ? { reason: check.reason } : {}),
			...(reprompt ? { reprompt: true } : {}),
			keybindings: { denyAbort: "escape" },
		});

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
		for (const [original, edited] of approved) {
			if (redirectOriginals.has(original)) continue;
			patterns.push({
				permission: opts.permission,
				pattern: isFile
					? toRecursiveGlob(normalizePathForMatching(edited ?? original, deps.ctx.cwd))
					: (edited ?? original),
			});
		}
		for (const rt of check.redirectTargets ?? []) {
			const editedPath = approved.get(rt.path) ?? rt.path;
			if (approved.has(rt.path)) {
				patterns.push({
					permission: rt.permission,
					pattern: toRecursiveGlob(normalizePathForMatching(editedPath, deps.ctx.cwd)),
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
		// Counters only consume durable approvals — "once" explicitly declined
		// persistence, so it is not evidence of a wanted rule. (Unreachable for
		// "once": that branch continues or returns above.)
		if (opts.permission === "bash") {
			deps.inferred?.recordApproval(check.unapproved ?? [], [deps.profile]);
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
