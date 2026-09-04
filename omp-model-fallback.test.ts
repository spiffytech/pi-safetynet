import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { resolveReviewerSpawnModel } from "./omp-pipeline.ts";

/**
 * resolveReviewerSpawnModel — the omp auto-review spawn-model translator.
 *
 * core/reviewer-state resolves each fallback-chain spec against the parent
 * registry and hands spawn a partial `{ id, provider }`; the reviewer child
 * disables extension discovery, so omp-pipeline must translate that partial
 * back into a full Model object (registry `find` first, facade provider/id,
 * then bare id) or the child boots model-less → "No model selected".
 *
 * Bun-only: importing omp-pipeline pulls omp's TS-source SDK deps that only
 * evaluate under Bun (omp's own runtime). Self-skips under Node.
 */
const bun = process.versions.bun !== undefined;
const d = bun ? describe : describe.skip;

d("resolveReviewerSpawnModel (Bun-only: omp TS-source deps)", () => {
	let resolveReviewerSpawnModelFn!: typeof resolveReviewerSpawnModel;
	const fullModel = { id: "glm-5.3-flash", provider: "hyper", baseUrl: "https://hyper.charm.land/v1" };

	before(async () => {
		const m = await import("./omp-pipeline.ts");
		resolveReviewerSpawnModelFn = m.resolveReviewerSpawnModel;
	});

	it("prefers the full-catalog registry lookup (provider + id)", () => {
		const ctx = {
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === "hyper" && id === "glm-5.3-flash" ? fullModel : undefined,
			},
			models: { resolve: () => undefined },
		};
		assert.equal(
			resolveReviewerSpawnModelFn(ctx as never, { id: "glm-5.3-flash", provider: "hyper" }),
			fullModel,
		);
	});

	it("falls back to the facade provider/id resolve when the registry misses", () => {
		const viaFacade = { id: "qwen3.8-flash", provider: "hyper", baseUrl: "https://hyper.charm.land/v1" };
		const ctx = {
			modelRegistry: { find: () => undefined },
			models: { resolve: (spec: string) => (spec === "hyper/qwen3.8-flash" ? viaFacade : undefined) },
		};
		assert.equal(
			resolveReviewerSpawnModelFn(ctx as never, { id: "qwen3.8-flash", provider: "hyper" }),
			viaFacade,
		);
	});

	it("falls back to the facade bare-id resolve (provider-less partial)", () => {
		const viaBare = { id: "qwen3.8-flash", provider: "hyper", baseUrl: "https://hyper.charm.land/v1" };
		const ctx = {
			modelRegistry: { find: () => undefined },
			models: { resolve: (spec: string) => (spec === "qwen3.8-flash" ? viaBare : undefined) },
		};
		assert.equal(resolveReviewerSpawnModelFn(ctx as never, { id: "qwen3.8-flash" }), viaBare);
	});

	it("returns undefined when the spec is nowhere in the catalog", () => {
		const ctx = {
			modelRegistry: { find: () => undefined },
			models: { resolve: () => undefined },
		};
		assert.equal(
			resolveReviewerSpawnModelFn(ctx as never, { id: "missing-model", provider: "hyper" }),
			undefined,
		);
	});

	it("returns undefined for an empty partial", () => {
		const ctx = {
			modelRegistry: { find: () => undefined },
			models: { resolve: () => undefined },
		};
		assert.equal(resolveReviewerSpawnModelFn(ctx as never, undefined), undefined);
		assert.equal(resolveReviewerSpawnModelFn(ctx as never, { id: "" }), undefined);
	});
});