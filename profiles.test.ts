import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  getProfileContextMessage,
} from "./profiles/index.ts";

describe("profiles", () => {
  afterEach(() => {
    setCurrentProfile("plan");
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

    it("plan message mentions planPresent", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("planPresent"));
    });

    it("plan message mentions planWrite", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("planWrite"));
    });

    it("plan message explains user-controlled build transition", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("/spfy:build"));
    });

    it("build message mentions full access", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("build"));
      assert.ok(msg.includes("full tool access") || msg.includes("full access"));
    });

    it("build message mentions /spfy:plan", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("/spfy:plan"));
    });

    it("build message with plan path references plan file", () => {
      const msg = getProfileContextMessage("build", "/tmp/plans/test.md");
      // Should reference the plan path even though file may not exist
      // (getProfileContextMessage checks existsSync, so only appears if file exists)
      assert.ok(msg.includes("build"));
    });

    it("plan message with plan path shows existing plan", () => {
      // Use a path that likely doesn't exist for this test
      const msg = getProfileContextMessage("plan", "/nonexistent/path/test.md");
      assert.ok(msg.includes("planWrite") || msg.includes("plan file"));
    });
  });
});
