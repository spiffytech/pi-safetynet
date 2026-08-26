/**
 * Interactive permission prompt for omp, built on ctx.ui.askDialog.
 *
 * Mirrors pi-safetynet's PermissionPromptComponent semantics without the
 * hand-built TUI: subcommand allowlist → one multi-select question,
 * duration → select with recommended default. Inline item editing is
 * deferred (escalate to a custom() component later if UX demands it).
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { PermissionDuration } from "./core/types.ts";

export type OmpPermissionPromptResult =
	| { kind: "approve"; approved: Map<string, string>; duration: PermissionDuration }
	| { kind: "deny"; reason?: string };
const DURATIONS: Array<{ value: PermissionDuration; label: string; description: string }> = [
	{ value: "once", label: "Just once", description: "Approve this invocation only; no rule created" },
	{ value: "turn", label: "This turn", description: "Allow for the rest of this agent turn" },
	{ value: "session", label: "This session", description: "Allow for the rest of this session (recommended)" },
	{ value: "project", label: "This project", description: "Persist to .omp/extensions/safetynet/approvals.json" },
	{ value: "global", label: "Globally", description: "Persist to ~/.config/pi-safetynet/config.json" },
];

export interface PromptItems {
	/** Canonical form of each unapproved item (subcommands + redirect target paths). */
	canonical: string[];
	/** Display form, parallel to canonical (preserves original quoting). */
	display: string[];
	/** Header shown above the questions. */
	title: string;
}

export async function showOmpPermissionPrompt(
	ctx: ExtensionContext,
	items: PromptItems,
): Promise<OmpPermissionPromptResult> {
	const ui = ctx.ui;

	if (!ui.askDialog) {
		// Headless / RPC surface without rich dialogs: fall back to confirm.
		const ok = await ui.confirm(items.title, `Approve: ${items.display.join("; ")}?`);
		if (!ok) return { kind: "deny" };
		return {
			kind: "approve",
			approved: new Map(items.canonical.map((c) => [c, c])),
			duration: "once",
		};
	}

	const result = await ui.askDialog([
		{
			id: "items",
			question: items.title,
			header: "Approve",
			multi: true,
			options: items.canonical.map((canonical, i) => ({
				label: items.display[i] ?? canonical,
				...(canonical === items.display[i] ? {} : { description: canonical }),
			})),
		},
		{
			id: "duration",
			question: "For how long?",
			header: "Duration",
			recommended: 2,
			options: DURATIONS.map((d) => ({ label: d.label, description: d.description })),
		},
	]);

	if (!result || result.kind !== "submit") {
		return { kind: "deny" };
	}

	const itemsResult = result.results.find((r) => r.id === "items");
	const durationResult = result.results.find((r) => r.id === "duration");

	const selected = itemsResult?.selectedOptions ?? [];
	if (selected.length === 0) {
		return { kind: "deny" };
	}

	// selectedOptions hold option labels; map back to canonical via display form.
	const approved = new Map<string, string>();
	for (const label of selected) {
		const idx = items.display.findIndex((d) => d === label);
		const canonical = idx >= 0 ? items.canonical[idx]! : label;
		approved.set(canonical, canonical);
	}

	const durationLabel = durationResult?.selectedOptions[0];
	const durationIdx = durationLabel
		? DURATIONS.findIndex((d) => d.label === durationLabel)
		: 2; // default "session"
	const duration = DURATIONS[Math.max(0, durationIdx === -1 ? 2 : durationIdx)]!.value;

	return { kind: "approve", approved, duration };
}
