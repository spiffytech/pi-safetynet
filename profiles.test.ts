import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  requiresApproval,
  getProfileContextMessage,
  getToolsForProfile,
} from "./profiles/index.ts";

describe("profiles", () => {
  afterEach(() => {
    setCurrentProfile("build");
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
    it("defaults to build", () => {
      assert.equal(getCurrentProfile(), "build");
    });

    it("can switch to plan", () => {
      setCurrentProfile("plan");
      assert.equal(getCurrentProfile(), "plan");
    });

    it("can switch back to build", () => {
      setCurrentProfile("plan");
      setCurrentProfile("build");
      assert.equal(getCurrentProfile(), "build");
    });
  });

  describe("getProfileContextMessage", () => {
    it("plan message mentions read-only", () => {
      const msg = getProfileContextMessage("plan");
      assert.ok(msg.includes("plan"));
      assert.ok(msg.includes("read-only") || msg.includes("restricted"));
    });

    it("build message mentions progressive trust or full access", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("build"));
    });
  });

  describe("getToolsForProfile", () => {
    it("plan mode includes read but NOT edit or write", () => {
      const tools = getToolsForProfile("plan");
      assert.ok(tools.includes("read"));
      assert.ok(!tools.includes("edit"));
      assert.ok(!tools.includes("write"));
    });

    it("build mode includes read, edit, and write", () => {
      const tools = getToolsForProfile("build");
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("edit"));
      assert.ok(tools.includes("write"));
    });

    it("both modes include switchProfile", () => {
      assert.ok(getToolsForProfile("plan").includes("switchProfile"));
      assert.ok(getToolsForProfile("build").includes("switchProfile"));
    });

    it("both modes include bash", () => {
      assert.ok(getToolsForProfile("plan").includes("bash"));
      assert.ok(getToolsForProfile("build").includes("bash"));
    });
  });
});
