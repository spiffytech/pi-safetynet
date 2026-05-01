import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeRules } from "./permissions/storage.ts";

describe("sanitizeRules", () => {
  it("passes valid rules through", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "allow", modes: ["build", "plan"] },
    ];
    assert.deepEqual(sanitizeRules(input), input);
  });

  it("filters out rules with missing modes", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "allow" },
    ];
    assert.deepEqual(sanitizeRules(input), []);
  });

  it("filters out rules with empty modes", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "allow", modes: [] },
    ];
    assert.deepEqual(sanitizeRules(input), []);
  });

  it("filters out rules with invalid modes", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "allow", modes: ["unknown"] },
    ];
    assert.deepEqual(sanitizeRules(input), []);
  });

  it("filters out rules with invalid permission", () => {
    const input = [
      { permission: "invalid", pattern: "ls *", action: "allow", modes: ["build"] },
    ];
    assert.deepEqual(sanitizeRules(input), []);
  });

  it("filters out rules with invalid action", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "invalid", modes: ["build"] },
    ];
    assert.deepEqual(sanitizeRules(input), []);
  });

  it("filters out non-object entries", () => {
    assert.deepEqual(sanitizeRules([null, undefined, "string", 42]), []);
  });

  it("keeps valid rules and filters invalid ones in mixed input", () => {
    const input = [
      { permission: "bash", pattern: "ls *", action: "allow", modes: ["build"] },
      { permission: "bash", pattern: "rm *", action: "allow" },
      { permission: "edit", pattern: "**", action: "ask", modes: ["build", "plan"] },
    ];
    assert.deepEqual(sanitizeRules(input), [
      { permission: "bash", pattern: "ls *", action: "allow", modes: ["build"] },
      { permission: "edit", pattern: "**", action: "ask", modes: ["build", "plan"] },
    ]);
  });
});
