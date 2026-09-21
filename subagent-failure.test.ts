import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSubagentFailure } from "./subagent.ts";
import {
  recordSubagentFailure,
  consumeSubagentFailure,
  clearSubagentFailures,
} from "./index.ts";

describe("isSubagentFailure", () => {
  it("treats a clean completion as success", () => {
    assert.equal(
      isSubagentFailure({ taskType: "explore", activities: [], turnCount: 3 }),
      false,
    );
  });

  it("flags setup and provider errors", () => {
    assert.equal(isSubagentFailure({ error: "no_model" }), true);
    assert.equal(isSubagentFailure({ error: "Error: out of credits" }), true);
    // Provider failures that arrived as stopReason "error" rather than a throw.
    assert.equal(isSubagentFailure({ error: "402 You're out of credits", activities: [] }), true);
    assert.equal(isSubagentFailure({ taskType: "explore", turnCount: 1, error: "inference backend error" }), true);
  });

  it("flags every non-completion, matching pi's own blocked/timeout convention", () => {
    assert.equal(isSubagentFailure({ aborted: true }), true);
    assert.equal(isSubagentFailure({ hitPermissionDenied: true }), true);
    assert.equal(isSubagentFailure({ hitTurnLimit: true }), true);
    assert.equal(isSubagentFailure({ hitTimeout: true }), true);
  });

  it("treats explicit false flags on a partial result as success", () => {
    // The empty-output and normal-completion paths carry every flag as false.
    assert.equal(
      isSubagentFailure({
        aborted: false,
        hitPermissionDenied: false,
        hitTurnLimit: false,
        hitTimeout: false,
        taskType: "build",
      }),
      false,
    );
  });

  it("ignores missing details", () => {
    assert.equal(isSubagentFailure(undefined), false);
    assert.equal(isSubagentFailure({}), false);
  });
});

describe("subagent failure side channel", () => {
  it("returns an isError patch only for recorded calls", () => {
    recordSubagentFailure("call_a");
    assert.deepEqual(consumeSubagentFailure("call_a"), { isError: true });
    assert.equal(consumeSubagentFailure("call_a"), undefined);
    assert.equal(consumeSubagentFailure("call_unrecorded"), undefined);
  });

  it("keys by toolCallId, so concurrent calls do not cross-contaminate", () => {
    recordSubagentFailure("call_fail");
    assert.deepEqual(consumeSubagentFailure("call_fail"), { isError: true });
    // A successful sibling call was never recorded, so it is untouched.
    assert.equal(consumeSubagentFailure("call_ok"), undefined);
  });

  it("clears unconsumed failures", () => {
    recordSubagentFailure("call_stale");
    clearSubagentFailures();
    assert.equal(consumeSubagentFailure("call_stale"), undefined);
  });
});
