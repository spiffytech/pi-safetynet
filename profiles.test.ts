import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  requiresApproval,
  getProfileContextMessage,
  getProfileSwitchMessage,
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
    it("plan message mentions read-only planning", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("plan"));
      assert.ok(msg.includes("READ-ONLY") || msg.includes("planning-only"));
    });

    it("build message mentions full access", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("build"));
      assert.ok(msg.includes("full tool access") || msg.includes("full access"));
    });

    it("build message includes plan-to-build transition via getProfileSwitchMessage", () => {
      const msg = getProfileSwitchMessage("plan", "build");
      assert.ok(msg.includes("changed from plan to build"));
    });
  });
});
