/**
 * Custom pi footer for pi-safetynet.
 *
 * Replicates the built-in footer (pwd / stats+model lines) and then splits the
 * extension statuses: OUR entries (currently just the safetynet mode label) land
 * on one dedicated line that is never crowded out or truncated away by other
 * extensions' statuses. Everyone else's statuses keep the built-in behaviour
 * (one shared line, sorted by key).
 *
 * Nothing about usage is apportioned here. Token/cost totals are summed from the
 * same session entries the built-in footer reads, which means delegated (subagent)
 * spend is folded into the normal stats line via the toolResult entry's `usage`
 * field, and cache-warming refreshes via `type: "usage"` entries. Replaces the
 * built-in footer only to protect the mode label from status-line truncation.
 *
 * Version note: this is written against the @earendil-works/pi-coding-agent
 * 0.86.x extension API (what pi-safetynet typechecks against).
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";

/**
 * Keys of the footer statuses this extension owns. Ordering is display order, so
 * if the line ever truncates it cuts from the right of this list. It currently
 * holds only the mode label — the read-only indicator must never be hidden.
 */
export const SAFETYNET_STATUS_KEYS = ["safetynet"] as const;
export type SafetynetStatusKey = (typeof SAFETYNET_STATUS_KEYS)[number];

export interface CustomFooterDeps {
	width: number;
	/** Minimal theme surface. Only fg/bold are used. */
	theme: Pick<Theme, "fg" | "bold">;
	/** All session entries, used for cumulative usage totals (like the built-in footer). */
	entries: readonly SessionEntry[];
	contextUsage?: {
		tokens?: number | null;
		contextWindow?: number;
		percent?: number | null;
	} | undefined;
	/** Current model id (e.g. "deepseek-v4-flash-0731"), or "no-model". */
	modelId: string;
	/** Current model provider id, when known (used for the "(provider)" prefix). */
	modelProvider: string | undefined;
	/** Whether the current model supports reasoning levels. */
	modelSupportsReasoning: boolean;
	/** Current thinking level ("off" | "high" | ...), when the model supports reasoning. */
	thinkingLevel: string;
	/** Number of providers with available models (built-in shows "(provider)" when > 1). */
	providerCount: number;
	/** True when the model is subscription-backed (adds " (sub)" to the cost). */
	usingSubscription: boolean;
	cwd: string;
	home?: string | undefined;
	gitBranch: string | null;
	sessionName: string | undefined;
	/** Whether auto compaction is enabled (adds " (auto)" to the context %). */
	autoCompact: boolean;
	extensionStatuses: ReadonlyMap<string, string>;
}

/** Sanitize status text for single-line display (built-in footer behavior). */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Format token counts for compact footer display (matches the built-in footer). */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Shorten cwd relative to home, like the built-in footer (~/...). */
export function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Split extension statuses into OUR entries (in the given key order) and
 * everyone else's (sorted by key, like the built-in footer).
 */
export function splitExtensionStatuses(
	statuses: ReadonlyMap<string, string>,
	ourKeys: readonly string[],
): { ours: string[]; others: string[] } {
	const ours: string[] = [];
	for (const key of ourKeys) {
		const text = statuses.get(key);
		if (!text) continue;
		const clean = sanitizeStatusText(text);
		if (clean) ours.push(clean);
	}
	const others = Array.from(statuses.entries())
		.filter(([key]) => !ourKeys.includes(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0);
	return { ours, others };
}

/** Accumulated usage across session entries (built-in footer totals). */
interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

function accumulateUsage(entries: readonly SessionEntry[]): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined };
	for (const entry of entries) {
		if (entry.type === "usage") {
			// Model-attributed usage that is not part of the conversation (currently
			// cache-warming refreshes). The built-in footer counts these; skipping
			// them would under-report cache reads and cost. Deliberately does not
			// touch latestCacheHitRate — a warming read is ~100% cached, which would
			// flatter the displayed hit rate.
			const usage = entry.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		} else if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				const usage = message.usage;
				totals.input += usage.input;
				totals.output += usage.output;
				totals.cacheRead += usage.cacheRead;
				totals.cacheWrite += usage.cacheWrite;
				totals.cost += usage.cost.total;
				const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				totals.latestCacheHitRate =
					latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (message.role === "toolResult" && message.usage) {
				const usage = message.usage;
				totals.input += usage.input;
				totals.output += usage.output;
				totals.cacheRead += usage.cacheRead;
				totals.cacheWrite += usage.cacheWrite;
				totals.cost += usage.cost.total;
			}
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			const usage = entry.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		}
	}
	return totals;
}

/**
 * Render the custom footer: pwd line, stats+model line, other extensions'
 * statuses line, then OUR dedicated statuses line. Pure — no pi runtime
 * access, so it is fully unit-testable.
 */
export function renderCustomFooter(deps: CustomFooterDeps): string[] {
	const { theme, width } = deps;

	// ── Cumulative usage from ALL session entries (matches built-in totals) ──
	const totals = accumulateUsage(deps.entries);

	// ── Context usage (handles compaction correctly: null percent → "?") ─────
	const contextUsage = deps.contextUsage;
	const contextWindow = contextUsage?.contextWindow ?? 0;
	const percent = contextUsage?.percent;
	const contextPercent = percent === null || percent === undefined ? "?" : percent.toFixed(1);
	const autoIndicator = deps.autoCompact ? " (auto)" : "";
	const contextPercentDisplay =
		contextPercent === "?"
			? `?/${formatTokens(contextWindow)}${autoIndicator}`
			: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
	let contextPercentStr = contextPercentDisplay;
	if (percent !== null && percent !== undefined) {
		if (percent > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (percent > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		}
	}

	// ── Pwd line: path (branch) • session name ───────────────────────────────
	let pwd = formatCwdForFooter(deps.cwd, deps.home);
	if (deps.gitBranch) pwd = `${pwd} (${deps.gitBranch})`;
	if (deps.sessionName) pwd = `${pwd} • ${deps.sessionName}`;
	const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

	// ── Stats line: tokens / cache / cost / context, model right-aligned ──────
	const statsParts: string[] = [];
	if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && totals.latestCacheHitRate !== undefined) {
		statsParts.push(`CH${totals.latestCacheHitRate.toFixed(1)}%`);
	}
	if (totals.cost || deps.usingSubscription) {
		statsParts.push(`$${totals.cost.toFixed(3)}${deps.usingSubscription ? " (sub)" : ""}`);
	}
	statsParts.push(contextPercentStr);

	let statsLeft = statsParts.join(" ");
	let statsLeftWidth = visibleWidth(statsLeft);
	if (statsLeftWidth > width) {
		statsLeft = truncateToWidth(statsLeft, width, "...");
		statsLeftWidth = visibleWidth(statsLeft);
	}

	const modelName = deps.modelId || "no-model";
	let rightSideWithoutProvider = modelName;
	if (deps.modelSupportsReasoning) {
		const thinkingLevel = deps.thinkingLevel || "off";
		rightSideWithoutProvider =
			thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
	}

	const minPadding = 2;
	let rightSide = rightSideWithoutProvider;
	if (deps.providerCount > 1 && deps.modelProvider) {
		rightSide = `(${deps.modelProvider}) ${rightSideWithoutProvider}`;
		if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
			// Too wide — fall back to provider-less
			rightSide = rightSideWithoutProvider;
		}
	}

	const rightSideWidth = visibleWidth(rightSide);
	const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

	let statsLine: string;
	if (totalNeeded <= width) {
		const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
		statsLine = statsLeft + padding + rightSide;
	} else {
		const availableForRight = width - statsLeftWidth - minPadding;
		if (availableForRight > 0) {
			const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
			const truncatedRightWidth = visibleWidth(truncatedRight);
			const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
			statsLine = statsLeft + padding + truncatedRight;
		} else {
			statsLine = statsLeft;
		}
	}

	// Dim each part separately — statsLeft may carry color codes ending in reset.
	const dimStatsLeft = theme.fg("dim", statsLeft);
	const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
	const dimRemainder = theme.fg("dim", remainder);

	const lines = [pwdLine, dimStatsLeft + dimRemainder];

	// ── Other extensions' statuses (built-in behavior: one line, truncated) ──
	const { ours, others } = splitExtensionStatuses(deps.extensionStatuses, SAFETYNET_STATUS_KEYS);
	if (others.length > 0) {
		lines.push(truncateToWidth(others.join(" "), width, theme.fg("dim", "...")));
	}

	// ── OUR dedicated line: all our entries on one line, always visible. ──────
	// Mode label is first, so if the line ever truncates it cuts the subagent
	// cost — never the read-only indicator.
	if (ours.length > 0) {
		lines.push(truncateToWidth(ours.join(" · "), width, theme.fg("dim", "...")));
	}

	return lines;
}