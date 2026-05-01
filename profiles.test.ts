import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  requiresApproval,
  getProfileContextMessage,
} from "./profiles/index.ts";

describe("profiles", () => {
  afterEach(() => {
    setCurrentProfile("plan");
  });

  describe("requiresApproval", () => {
    it("plan -> build requires approval", () => {
      assert.equal(requiresApproval("plan", "build"), true);
    });

    it("build -> plan does NOT require approval", () => {
      assert.equal(requiresApproval("build", "plan"), false);
    });
  });

  describe("getCurrentProfile / setCurrentProfile", () => {
    it("defaults to plan", () => {
      assert.equal(getCurrentProfile(), "plan");
    });

    it("can switch to build", () => {
      setCurrentProfile("build");
      assert.equal(getCurrentProfile(), "build");
    });

    it("can switch back to plan", () => {
      setCurrentProfile("build");
      setCurrentProfile("plan");
      assert.equal(getCurrentProfile(), "plan");
    });
  });

  describe("getProfileContextMessage", () => {
    it("plan message mentions cautious mode", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("plan"));
      assert.ok(msg.includes("approval") || msg.includes("cautious"));
    });

    it("build message mentions progressive trust or full access", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("build"));
    });
  });
});
