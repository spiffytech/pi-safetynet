/**
 * judge-adapter.test.ts — the inferred judge's production adapter.
 *
 * Verifies the request is scoped to the judge prompt only (no session
 * transcript), that usage is written back to Pi's native accounting, and that
 * provider/abort/timeout failures surface as rejections (transient verdicts).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { createJudgeAsk, recordBackgroundUsage } from "./judge-adapter.ts";
import { JUDGE_SYSTEM_PROMPT, JUDGE_TOOL_NAME, JUDGE_VERDICT_SCHEMA } from "./judge.ts";

const MODEL = { id: "judge-model", provider: "judge-provider", api: "anthropic-messages", name: "judge" };

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	};
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: JUDGE_TOOL_NAME, arguments: { verdict: "offer" } }],
		api: "anthropic-messages",
		provider: "judge-provider",
		model: "judge-model",
		usage: usage(10, 5),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	} as AssistantMessage;
}

interface Harness {
	ctx: any;
	streams: number;
	sentContext: any;
	sentOptions: any;
	appended: { kind: string; provider: string; model: string; usage: Usage; note?: string }[];
}

function makeCtx(result: (options: any) => Promise<AssistantMessage>): Harness {
	const h: Harness = { streams: 0, sentContext: undefined, sentOptions: undefined, appended: [], ctx: undefined };
	h.ctx = {
		model: MODEL,
		sessionManager: {
			appendUsage: (kind: string, provider: string, model: string, u: Usage, note?: string) => {
				h.appended.push({ kind, provider, model, usage: u, ...(note ? { note } : {}) });
			},
		},
		modelRegistry: {
			getAll: () => [MODEL],
			streamSimple: (_model: unknown, context: unknown, options: unknown) => {
				h.streams++;
				h.sentContext = context;
				h.sentOptions = options;
				return { result: () => result(options) };
			},
		},
	};
	return h;
}

const originalHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
	// No safetynet config.json → autoApprove.model unset → ctx.model is used.
	tmpHome = mkdtempSync(join(tmpdir(), "safetynet-judge-adapter-"));
	process.env.HOME = tmpHome;
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("createJudgeAsk", () => {
	it("sends only the judge system prompt, the judge prompt, and the verdict tool", async () => {
		const h = makeCtx(async () => assistantMessage());
		const ask = createJudgeAsk(h.ctx);

		const verdict = await ask("A bash shape recurred. Decide.");

		assert.equal(h.streams, 1);
		assert.equal(h.sentContext.systemPrompt, JUDGE_SYSTEM_PROMPT);
		assert.equal(h.sentContext.messages.length, 1, "exactly one message");
		assert.equal(h.sentContext.messages[0].role, "user");
		assert.equal(h.sentContext.messages[0].content, "A bash shape recurred. Decide.");
		assert.equal(h.sentContext.tools?.[0]?.name, JUDGE_TOOL_NAME, "verdict tool declared");
		assert.deepEqual(verdict, { verdict: "offer" }, "returns the tool-call arguments, not prose");
	});

	it("rejects when the model never calls the verdict tool", async () => {
		const h = makeCtx(async () => assistantMessage({ content: [{ type: "text", text: '{"verdict":"offer"}' }] }));
		await assert.rejects(() => createJudgeAsk(h.ctx)("prompt"), /did not call submit_judge_verdict/);
	});

	it("records the harvested usage as an inferred_judge entry", async () => {
		const expected = usage(123, 45);
		const h = makeCtx(async () => assistantMessage({ usage: expected }));
		await createJudgeAsk(h.ctx)("prompt");

		assert.equal(h.appended.length, 1);
		assert.equal(h.appended[0]!.kind, "inferred_judge");
		assert.equal(h.appended[0]!.provider, "judge-provider");
		assert.equal(h.appended[0]!.model, "judge-model");
		assert.equal(h.appended[0]!.usage, expected);
	});

	it("attributes usage to the concrete responseModel when the provider reports one", async () => {
		const h = makeCtx(async () => assistantMessage({ responseModel: "judge-model-2026" }));
		await createJudgeAsk(h.ctx)("prompt");
		assert.equal(h.appended[0]!.model, "judge-model-2026");
	});

	it("rejects on an error stopReason so the caller records a transient verdict", async () => {
		const h = makeCtx(async () => assistantMessage({ stopReason: "error", errorMessage: "overloaded" }));
		await assert.rejects(() => createJudgeAsk(h.ctx)("prompt"), /overloaded/);
		assert.equal(h.appended.length, 0, "failed calls are not billed");
	});

	it("rejects on an aborted stopReason", async () => {
		const h = makeCtx(async () => assistantMessage({ stopReason: "aborted" }));
		await assert.rejects(() => createJudgeAsk(h.ctx)("prompt"));
	});

	it("rejects when the provider stream rejects", async () => {
		const h = makeCtx(async () => {
			throw new Error("provider exploded");
		});
		await assert.rejects(() => createJudgeAsk(h.ctx)("prompt"), /provider exploded/);
	});

	it("tolerates a sessionManager without appendUsage", async () => {
		const h = makeCtx(async () => assistantMessage());
		h.ctx.sessionManager = {};
		const verdict = await createJudgeAsk(h.ctx)("prompt");
		assert.deepEqual(verdict, { verdict: "offer" });
	});

	it("aborts the request when the judge times out", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const h = makeCtx(
			(options) =>
				new Promise<AssistantMessage>((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("judge timed out")), { once: true });
				}),
		);

		const pending = createJudgeAsk(h.ctx)("prompt");
		t.mock.timers.tick(30_000);
		await assert.rejects(() => pending, /judge timed out/);
	});
});

describe("judge verdict schema", () => {
	it("stays strict-compatible so constrained sampling is actually applied", () => {
		const s = JUDGE_VERDICT_SCHEMA as any;
		assert.equal(s.additionalProperties, false);
		assert.ok(s.required.includes("candidates"), "candidates must be required (an optional array becomes an unsupported anyOf-with-null)");
		assert.equal(s.properties.candidates.type, "array");
		const candidate = s.properties.candidates.items;
		assert.equal(candidate.additionalProperties, false);
		assert.ok(candidate.required.includes("pins"), "pins must be required");
		assert.equal(candidate.properties.pins.type, "array");
		assert.ok(!("patternProperties" in candidate.properties.pins), "pins must be an array, not a dynamic map");
		assert.equal(candidate.properties.pins.items.properties.index.type, "integer");
		// No optional object/array property: it would be wrapped in anyOf-with-null and rejected.
		for (const key of Object.keys(s.properties)) {
			if (s.required.includes(key)) continue;
			assert.ok(!["object", "array"].includes(s.properties[key].type), `${key} is an optional ${s.properties[key].type}`);
		}
	});
});

describe("recordBackgroundUsage", () => {
	it("is a no-op when appendUsage is absent", () => {
		assert.doesNotThrow(() =>
			recordBackgroundUsage({ sessionManager: {} } as any, "inferred_judge", assistantMessage()),
		);
	});
});
