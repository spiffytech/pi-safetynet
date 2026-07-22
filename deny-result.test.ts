import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { denyResultFromPrompt } from "./index.ts";
import type { PermissionPromptResult } from "./prompts.ts";

// Regression tests for the deny-with-reason → block-the-command mapping.
//
// The contract under test: when the user denies a permission prompt (with or
// without a typed reason, or via Esc), the requested command must NOT run —
// `resolvePermission` returns `{ block: true, reason }` and pi's tool executor
// treats `block: true` as "do not run." The deny-with-reason path is
// non-aborting (the model keeps its turn and sees the reason as the tool's
// error result); the Esc path additionally aborts the turn.

describe("denyResultFromPrompt", () => {
  it("deny-with-reason blocks and is non-aborting, surfacing the typed reason", () => {
    const result = denyResultFromPrompt(
      { kind: "deny", explanation: "too risky" },
      "bash",
    );
    assert.deepEqual(result, { block: true, reason: "too risky", abort: false });
  });

  it("whitespace-only explanation trims to fallback banner and stays non-aborting", () => {
    // prompts.ts already trims on submit; this guards against a non-trimmed
    // value slipping through (e.g. only spaces) — "" is falsy → fallback.
    const result = denyResultFromPrompt(
      { kind: "deny", explanation: "   " },
      "bash",
    );
    assert.deepEqual(result, { block: true, reason: "User denied bash", abort: false });
  });

  it("empty explanation (plain deny) falls back to default banner, non-aborting", () => {
    const result = denyResultFromPrompt(
      { kind: "deny", explanation: "" },
      "edit",
    );
    assert.deepEqual(result, { block: true, reason: "User denied edit", abort: false });
  });

  it("deny-with-reason works for the read permission too", () => {
    const result = denyResultFromPrompt(
      { kind: "deny", explanation: "secret" },
      "read",
    );
    assert.deepEqual(result, { block: true, reason: "secret", abort: false });
  });

  it("Esc (null result) blocks AND aborts the turn", () => {
    const result = denyResultFromPrompt(null, "bash");
    assert.deepEqual(result, { block: true, reason: "User denied bash", abort: true });
  });

  it("approval returns undefined (caller proceeds with rule creation)", () => {
    const approved: PermissionPromptResult = {
      kind: "approve",
      approved: new Map([["rm -rf /tmp/foo", "rm -rf /tmp/foo"]]),
      skipped: [],
      skippedDisplay: [],
      duration: "once",
    };
    const result = denyResultFromPrompt(approved, "bash");
    assert.equal(result, undefined);
  });

  it("ALWAYS returns block:true for deny — command must never run", () => {
    // Exhaustive property-style guard across every deny-shaped input.
    const cases: Array<{ input: Parameters<typeof denyResultFromPrompt>[0] }> = [
      { input: null },
      { input: { kind: "deny", explanation: "" } },
      { input: { kind: "deny", explanation: "x" } },
    ];
    for (const { input } of cases) {
      const r = denyResultFromPrompt(input, "bash");
      assert.equal(r?.block, true, `expected block:true for ${JSON.stringify(input)}`);
    }
  });
});
