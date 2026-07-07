import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headlessDeny } from "./index.ts";

describe("headlessDeny", () => {
  it("denies ask action when hasUI is false (bash)", () => {
    const result = headlessDeny(false, "ask", "bash");
    assert.deepEqual(result, { block: true, reason: "Bash requires approval (headless mode)" });
  });

  it("denies ask action when hasUI is false (edit)", () => {
    const result = headlessDeny(false, "ask", "edit");
    assert.deepEqual(result, { block: true, reason: "Edit requires approval (headless mode)" });
  });

  it("denies ask action when hasUI is false (read)", () => {
    const result = headlessDeny(false, "ask", "read");
    assert.deepEqual(result, { block: true, reason: "Read requires approval (headless mode)" });
  });

  it("returns undefined when hasUI is true and action is ask", () => {
    const result = headlessDeny(true, "ask", "bash");
    assert.equal(result, undefined);
  });

  it("returns undefined when hasUI is false and action is allow", () => {
    const result = headlessDeny(false, "allow", "bash");
    assert.equal(result, undefined);
  });

  it("returns undefined when hasUI is false and action is deny", () => {
    const result = headlessDeny(false, "deny", "bash");
    assert.equal(result, undefined);
  });

  it("returns undefined when hasUI is true and action is allow", () => {
    const result = headlessDeny(true, "allow", "edit");
    assert.equal(result, undefined);
  });
});

describe("headlessDeny with autoDenyReason", () => {
  it("uses the provided reason when given", () => {
    const result = headlessDeny(false, "ask", "bash", "project policy: no network");
    assert.deepEqual(result, { block: true, reason: "project policy: no network" });
  });

  it("falls back to the default banner when reason is undefined", () => {
    const result = headlessDeny(false, "ask", "bash", undefined);
    assert.deepEqual(result, { block: true, reason: "Bash requires approval (headless mode)" });
  });

  it("falls back to the default banner when reason is empty string", () => {
    const result = headlessDeny(false, "ask", "edit", "");
    assert.deepEqual(result, { block: true, reason: "Edit requires approval (headless mode)" });
  });
});
