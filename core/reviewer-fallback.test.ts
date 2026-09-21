import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPermissionReview, formatReviewerFallback } from "./reviewer-state.ts";

/** Minimal ReviewCallOpts for exercising the fallback loop. */
function opts(model: string | string[], overrides: Record<string, unknown> = {}) {
  return {
    permission: "bash" as const,
    target: "touch x",
    check: { action: "ask" as const },
    cwd: "/tmp",
    parentCtx: { sessionManager: { getEntries: () => [] } } as any,
    profile: "build" as const,
    timeoutMs: 100,
    model,
    ...overrides,
  } as any;
}

const ALLOW = (spec: string) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        risk_level: "low",
        user_authorization: "high",
        outcome: "allow",
        rationale: `ok via ${spec}`,
      }),
    },
  ],
  details: {},
});

const FAIL = { content: [{ type: "text" as const, text: "not json at all" }], details: {} };

describe("formatReviewerFallback", () => {
  it("names each failed model with its reason and the winner", () => {
    const out = formatReviewerFallback(
      [
        { spec: "hyper/glm-5.3-flash", message: "Could not parse reviewer JSON output" },
        { spec: "hyper/qwen3.8-flash", message: "Reviewer timed out" },
      ],
      "neuralwatt/deepseek-v4.1-flash",
    );
    assert.equal(
      out,
      "reviewer fell back: hyper/glm-5.3-flash (Could not parse reviewer JSON output), " +
        "hyper/qwen3.8-flash (Reviewer timed out) → neuralwatt/deepseek-v4.1-flash",
    );
  });

  it("reports an all-failed chain without a winner", () => {
    const out = formatReviewerFallback([{ spec: "hyper/glm-5.3-flash", message: "Reviewer timed out" }]);
    assert.equal(
      out,
      "reviewer unavailable — all models failed: hyper/glm-5.3-flash (Reviewer timed out)",
    );
  });
});

describe("runPermissionReview — fallback diagnostics", () => {
  it("emits nothing when the first model succeeds", async () => {
    const seen: Array<[string, string]> = [];
    const v = await runPermissionReview(opts(["a/one"]), {
      spawn: async () => ALLOW("a/one"),
      onDiagnostic: (m, l) => seen.push([m, l]),
    });
    assert.equal(v.kind, "assessment");
    assert.deepEqual(seen, [], "no fallback happened → no diagnostic");
  });

  it("emits one aggregated warning when a later model produces the verdict", async () => {
    const seen: Array<[string, string]> = [];
    let call = 0;
    const v = await runPermissionReview(opts(["a/one", "b/two", "c/three"]), {
      // First two attempts fail, third succeeds (spawn gets no model object
      // here because parentCtx has no modelRegistry, so count calls instead).
      spawn: async () => (++call === 3 ? ALLOW("c/three") : FAIL),
      onDiagnostic: (m, l) => seen.push([m, l]),
    });
    assert.equal(v.kind, "assessment");
    assert.equal(seen.length, 1, "exactly one aggregated line, not one per hop");
    assert.equal(seen[0]![1], "warning");
    assert.match(seen[0]![0], /^reviewer fell back: /);
    assert.match(seen[0]![0], /a\/one \(/);
    assert.match(seen[0]![0], /b\/two \(/);
    assert.match(seen[0]![0], /→ c\/three$/);
  });

  it("emits one all-failed warning when every model fails", async () => {
    const seen: Array<[string, string]> = [];
    const v = await runPermissionReview(opts(["a/one", "b/two"]), {
      spawn: async () => FAIL,
      onDiagnostic: (m, l) => seen.push([m, l]),
    });
    assert.notEqual(v.kind, "assessment");
    assert.equal(seen.length, 1);
    assert.match(seen[0]![0], /^reviewer unavailable — all models failed: /);
    assert.match(seen[0]![0], /a\/one \(/);
    assert.match(seen[0]![0], /b\/two \(/);
  });

  it("stays silent when no model is configured (single parent-model attempt)", async () => {
    const seen: Array<[string, string]> = [];
    const v = await runPermissionReview(opts([] as any, { model: undefined }), {
      spawn: async () => FAIL,
      onDiagnostic: (m, l) => seen.push([m, l]),
    });
    assert.notEqual(v.kind, "assessment");
    assert.deepEqual(seen, [], "empty chain takes the single-attempt path and reports no fallback");
  });

  it("never throws when the diagnostic sink is absent", async () => {
    const v = await runPermissionReview(opts(["a/one", "b/two"]), { spawn: async () => FAIL });
    assert.notEqual(v.kind, "assessment");
  });
});
