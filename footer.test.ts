import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
	formatTokens,
	formatCwdForFooter,
	splitExtensionStatuses,
	renderCustomFooter,
	SAFETYNET_STATUS_KEYS,
	type CustomFooterDeps,
} from "./footer.ts";

/** Theme stub: everything passes through unchanged. */
const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Pick<Theme, "fg" | "bold">;

/** Theme stub that marks error/warning coloring so tests can assert on it. */
const markerTheme = {
	fg: (name: string, text: string) => (name === "error" || name === "warning" ? `<${name}>${text}</${name}>` : text),
	bold: (text: string) => text,
} as unknown as Pick<Theme, "fg" | "bold">;

const entry = (e: unknown) => e as SessionEntry;

function makeDeps(overrides: Partial<CustomFooterDeps> = {}): CustomFooterDeps {
	return {
		width: 120,
		theme,
		entries: [],
		modelId: "deepseek-v4-flash",
		modelProvider: "hyper",
		modelSupportsReasoning: true,
		thinkingLevel: "high",
		providerCount: 3,
		usingSubscription: false,
		cwd: "/home/user/proj",
		home: "/home/user",
		gitBranch: "main",
		sessionName: "my-session",
		autoCompact: true,
		extensionStatuses: new Map(),
		...overrides,
	};
}

/** An assistant entry carrying the given usage numbers. */
function assistantEntry(input: number, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0): SessionEntry {
	return entry({
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens: input + output + cacheRead + cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
		},
	});
}

/** A toolResult entry carrying usage — what subagent spend rides on. */
function toolResultUsageEntry(input: number, cost = 0): SessionEntry {
	return entry({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "subagent_explore",
			content: [{ type: "text", text: "done" }],
			usage: {
				input,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			isError: false,
			timestamp: 0,
		},
	});
}

/** A `usage` session entry, as cache warming writes them. */
function cacheWarmEntry(input: number, cacheRead: number, cost = 0): SessionEntry {
	return entry({
		type: "usage",
		kind: "cache_warm",
		provider: "hyper",
		model: "deepseek-v4.1-flash",
		usage: {
			input,
			output: 0,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + cacheRead,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
	});
}

describe("formatTokens", () => {
	it("formats like the built-in footer", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(45_000), "45k");
		assert.equal(formatTokens(1_234_567), "1.2M");
		assert.equal(formatTokens(12_345_678), "12M");
	});
});

describe("formatCwdForFooter", () => {
	it("abbreviates home to ~", () => {
		assert.equal(formatCwdForFooter("/home/user", "/home/user"), "~");
		assert.equal(formatCwdForFooter("/home/user/proj", "/home/user"), "~/proj");
	});
	it("keeps paths outside home verbatim", () => {
		assert.equal(formatCwdForFooter("/opt/other", "/home/user"), "/opt/other");
	});
	it("returns cwd when no home is known", () => {
		assert.equal(formatCwdForFooter("/home/user/proj", undefined), "/home/user/proj");
	});
});

describe("splitExtensionStatuses", () => {
	it("returns our entries in SAFETYNET_STATUS_KEYS order", () => {
		const { ours } = splitExtensionStatuses(
			new Map([["safetynet", "read-only auto"]]),
			SAFETYNET_STATUS_KEYS,
		);
		assert.deepEqual(ours, ["read-only auto"]);
	});
	it("sanitizes our status text", () => {
		const { ours } = splitExtensionStatuses(
			new Map([["safetynet", "read-only\nauto\t(2)"]]),
			SAFETYNET_STATUS_KEYS,
		);
		assert.deepEqual(ours, ["read-only auto (2)"]);
	});
	it("sorts others by key and excludes our keys", () => {
		const { ours, others } = splitExtensionStatuses(
			new Map([
				["tps", "41.2 TPS"],
				["kilo-credits", "2.1k"],
				["safetynet", "read-only"],
			]),
			SAFETYNET_STATUS_KEYS,
		);
		assert.deepEqual(ours, ["read-only"]);
		assert.deepEqual(others, ["2.1k", "41.2 TPS"]);
	});
	it("drops empty status texts", () => {
		const { ours } = splitExtensionStatuses(new Map([["safetynet", "   "]]), SAFETYNET_STATUS_KEYS);
		assert.deepEqual(ours, []);
	});
});

describe("renderCustomFooter", () => {
	it("renders pwd + stats lines with no statuses", () => {
		const lines = renderCustomFooter(makeDeps());
		assert.equal(lines.length, 2);
		assert.equal(lines[0], "~/proj (main) • my-session");
		assert.ok(lines[1]?.includes("?/0 (auto)"));
		assert.ok(lines[1]?.endsWith("(hyper) deepseek-v4-flash • high"));
	});

	it("omits the provider prefix when only one provider is available", () => {
		const lines = renderCustomFooter(makeDeps({ providerCount: 1 }));
		assert.ok(lines[1]?.endsWith("deepseek-v4-flash • high"));
		assert.ok(!lines[1]?.includes("(hyper)"));
	});

	it("shows thinking off when the model supports reasoning and level is off", () => {
		const lines = renderCustomFooter(makeDeps({ thinkingLevel: "off" }));
		assert.ok(lines[1]?.endsWith("deepseek-v4-flash • thinking off"));
	});

	it("shows usage totals on the stats line", () => {
		const lines = renderCustomFooter(
			makeDeps({ entries: [assistantEntry(1234, 500, 2000, 0, 0.123)] }),
		);
		assert.ok(lines[1]?.includes("↑1.2k"));
		assert.ok(lines[1]?.includes("↓500"));
		assert.ok(lines[1]?.includes("R2.0k"));
		assert.ok(lines[1]?.includes("$0.123"));
		// cacheRead > 0 → cache-hit rate shown
		assert.ok(lines[1]?.includes("CH"));
	});

	it("adds (sub) when the model is subscription-backed", () => {
		const lines = renderCustomFooter(makeDeps({ usingSubscription: true }));
		assert.ok(lines[1]?.includes("$0.000 (sub)"));
	});

	it("colorizes context usage above 90%", () => {
		const lines = renderCustomFooter(
			makeDeps({
				theme: markerTheme,
				contextUsage: { percent: 95, contextWindow: 128_000, tokens: 121_600 },
			}),
		);
		assert.ok(lines[1]?.includes("<error>95.0%/128k (auto)</error>"));
	});

	it("colorizes context usage above 70%", () => {
		const lines = renderCustomFooter(
			makeDeps({
				theme: markerTheme,
				contextUsage: { percent: 75, contextWindow: 128_000, tokens: 96_000 },
			}),
		);
		assert.ok(lines[1]?.includes("<warning>75.0%/128k (auto)</warning>"));
	});

	it("keeps other extensions' statuses on their own line, ours on the last line", () => {
		const lines = renderCustomFooter(
			makeDeps({
				extensionStatuses: new Map([
					["tps", "41.2 TPS"],
					["kilo-credits", "2.1k"],
					["safetynet", "read-only auto"],
				]),
			}),
		);
		assert.equal(lines.length, 4);
		assert.equal(lines[2], "2.1k 41.2 TPS");
		assert.equal(lines[3], "read-only auto");
	});

	it("renders only the ours line when there are no other statuses", () => {
		const lines = renderCustomFooter(
			makeDeps({ extensionStatuses: new Map([["safetynet", "read-only"]]) }),
		);
		assert.equal(lines.length, 3);
		assert.equal(lines[2], "read-only");
	});

	it("truncating the ours line keeps the mode label", () => {
		const lines = renderCustomFooter(
			makeDeps({
				width: 20,
				extensionStatuses: new Map([
					["safetynet", "read-only auto with a very long suffix"],
				]),
			}),
		);
		const oursLine = lines[2] ?? "";
		assert.equal(lines.length, 3);
		assert.ok(oursLine.startsWith("read-only auto"));
		assert.ok(visibleWidth(oursLine) <= 20);
		assert.ok(oursLine.includes("..."));
	});

	it("counts toolResult usage (subagent spend) in the totals", () => {
		const lines = renderCustomFooter(
			makeDeps({ entries: [assistantEntry(1000, 100, 0, 0, 0.01), toolResultUsageEntry(4000, 0.02)] }),
		);
		assert.ok(lines[1]?.includes("↑5.0k"));
		assert.ok(lines[1]?.includes("$0.030"));
	});

	it("counts cache-warming usage entries without touching the cache-hit rate", () => {
		const lines = renderCustomFooter(
			makeDeps({
				entries: [
					assistantEntry(1000, 100, 9000, 0, 0.01),
					cacheWarmEntry(0, 200_000, 0.05),
				],
			}),
		);
		assert.ok(lines[1]?.includes("R209k"), `expected R209k in ${lines[1]}`);
		assert.ok(lines[1]?.includes("$0.060"), `expected $0.060 in ${lines[1]}`);
		// 9000 / (1000 + 9000) = 90.0% — the warming read must not flatter it.
		assert.ok(lines[1]?.includes("CH90.0%"), `expected CH90.0% in ${lines[1]}`);
	});
});