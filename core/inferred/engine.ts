/**
 * engine.ts — orchestrates the inferred-rules lifecycle for one session.
 *
 * recordApproval (called from both approval sites — reviewer-allow and
 * manual prompt approvals) feeds the shape counters; a ripened shape runs
 * the dedup gate, then the judge in the background, then lands in the
 * pending queue with a UI callback. Accepted rules flow into the
 * InferredRuleStore and participate in checkBashPermission via
 * rulesForProfile().
 *
 * Everything here is fail-safe: any error in the pipeline is swallowed and
 * logged — the inferred layer must never break the permission path.
 */

import { subcommandTokenLists } from "../bash-parser.ts";
import type { ProfileName, ModeAliases, PermissionDuration } from "../types.ts";
import { ShapeCounters, type RipenedShape } from "./counters.ts";
import { InferredRuleStore, ProposalQueue, type InferredBashRule, type PendingProposal } from "./store.ts";
import { renderPattern, learnBoundary } from "./shapes.ts";
import { saveLearnedBoundaries } from "./learned.ts";
import { runInferredJudge, type JudgeDeps } from "./judge.ts";

export interface EngineHooks {
	/** UI callbacks. All optional; the engine never requires a UI. */
	onProposalQueued?: (proposal: PendingProposal) => void;
	/** Open the non-blocking review popup. The engine does not await it. */
	openReviewPopup?: () => void;
}

export class InferredEngine {
	private counters = new ShapeCounters();
	private store: InferredRuleStore;
	private queue: ProposalQueue;
	/** Shapes currently being judged (dedup within a session). */
	private inFlight = new Set<string>();
	private cwd: string;
	/** UI callbacks. All optional; the engine never requires a UI. Public
	 *  because the frontend rebinds them per event context. */
	hooks: EngineHooks = {};

	constructor(cwd: string, hooks: EngineHooks = {}) {
		this.cwd = cwd;
		this.hooks = hooks;
		this.store = new InferredRuleStore(cwd);
		this.queue = new ProposalQueue(cwd);
	}

	/** Feed one approved bash command (the full command string; each of its
	 *  subcommands is recorded separately). Fire-and-forget safe. */
	recordApproval(command: string, modes: ProfileName[]): void {
		try {
			const lists = subcommandTokenLists(command);
			for (const tokens of lists) {
				const ripened = this.counters.record(tokens);
				if (ripened) void this.offer(ripened, modes);
			}
		} catch (err) {
			console.warn(`safetynet inferred: recordApproval failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	/** Dedup gate → judge (background) → queue → UI. */
	private async offer(ripened: RipenedShape, modes: ProfileName[]): Promise<void> {
		try {
			if (this.inFlight.has(ripened.key)) return;
			this.inFlight.add(ripened.key);
			try {
				await this.offerInner(ripened, modes);
			} finally {
				this.inFlight.delete(ripened.key);
			}
		} catch (err) {
			console.warn(`safetynet inferred: offer failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	private async offerInner(ripened: RipenedShape, modes: ProfileName[]): Promise<void> {
		const render = renderPattern(ripened.pattern);
		if (this.store.hasEquivalent(render)) return; // already ratified (any scope)
		if (this.queue.list().some((p) => p.render === render)) return; // already pending

		const exemplars = ripened.exemplars.map((t) => t.join(" "));
		const exemplarTokens = ripened.exemplars;

		// Judge runs in the background; verdict decides whether anything is
		// queued. The caller gave us an ask adapter via offerJudge adapter on
		// the engine instance.
		if (!this.judgeDeps) return;
		const verdict = await runInferredJudge(
			{ render, pattern: ripened.pattern, exemplars, exemplarTokens, count: ripened.count },
			this.judgeDeps,
		);
		if (verdict.kind !== "offer") return; // reject or transient → no offer

		// The last candidate is always the full mechanical merge; judge-ranked
		// candidates (pin variants) come first. v1 offers the first validated
		// candidate and records the rank in annotations.
		const pattern = verdict.candidates[0] ?? ripened.pattern;
		const proposal: PendingProposal = {
			id: `inf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			render: renderPattern(pattern),
			pattern,
			exemplars,
			count: ripened.count,
			createdAt: Date.now(),
		};
		const queued = this.queue.enqueue(proposal, {
			// Dedup gate: if the exemplar is already allowed by the live ruleset,
			// the ask would not recur — silently consume the ripening.
			suppressIfAllowed: (exemplar) => this.suppressIfAllowed?.(exemplar) ?? false,
		});
		if (!queued) return;
		this.hooks.onProposalQueued?.(proposal);
		this.hooks.openReviewPopup?.();
	}

	/** Pipeline injects the ask adapter + suppression predicate together. */
	judgeDeps?: JudgeDeps;
	suppressIfAllowed?: (exemplar: string) => boolean;

	// ── Enforcement ────────────────────────────────────────────────────────

	/** Accepted inferred rules for the current profile, for
	 *  checkBashPermission's optional `inferred` parameter. */
	rulesForProfile(profile: ProfileName, modeAliases: ModeAliases): InferredBashRule[] {
		try {
			return this.store
				.all()
				.filter((r) => r.modes.includes(profile) || Object.values(modeAliases).some((a) => a === profile && r.modes.includes(a)));
		} catch {
			return [];
		}
	}

	// ── Queue review actions ───────────────────────────────────────────────

	listProposals(): PendingProposal[] {
		return this.queue.list();
	}

	/** Accept a proposal at a durable duration. Returns the accepted rule's
	 *  render, or undefined (unknown id / non-durable duration). */
	accept(
		id: string,
		duration: Exclude<PermissionDuration, "once" | "turn">,
		modes: ProfileName[],
	): string | undefined {
		const p = this.queue.remove(id);
		if (!p) return undefined;
		const rule: InferredBashRule = {
			id: p.id,
			render: p.render,
			pattern: p.pattern,
			modes,
			exemplars: p.exemplars.slice(0, 3),
			scope: duration,
			acceptedAt: Date.now(),
		};
		this.store.accept(rule);
		return p.render;
	}

	/** Drop a proposal — and teach: tokens immediately preceding free slots
	 *  become learned execution boundaries (the user judged them runner-verb
	 * -like). Persisted globally; shapes.ts consults them at merge time. */
	drop(id: string): PendingProposal | undefined {
		const p = this.queue.remove(id);
		if (p) {
			try {
				const toks = p.pattern.tokens;
				for (let i = 1; i < toks.length; i++) {
					if (toks[i]!.kind !== "slot") continue;
					const prev = toks[i - 1]!;
					if (prev.kind === "lit") learnBoundary(prev.text);
					else if (prev.kind === "assign") learnBoundary(`${prev.key}=`);
				}
				saveLearnedBoundaries();
			} catch (err) {
				console.warn(`safetynet inferred: boundary learning failed: ${err instanceof Error ? err.message : err}`);
			}
		}
		return p;
	}

	/** Accepted rules (for the rules listing). */
	allRules(): InferredBashRule[] {
		return this.store.all();
	}
}
