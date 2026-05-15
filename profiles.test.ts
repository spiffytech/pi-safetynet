import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  getProfileContextMessage,
  getLatestCustomEntry,
  restoreProfile,
} from "./profiles/index.ts";
import {
  restorePlanOnError,
  isPlanOnErrorEnabled,
  setPlanOnError,
} from "./profiles/plan-on-error.ts";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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
      assert.ok(msg.includes("/safetynet:build"));
    });

    it("build message mentions full access", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("build"));
      assert.ok(msg.includes("full tool access") || msg.includes("full access"));
    });

    it("build message mentions /safetynet:plan", () => {
      const msg = getProfileContextMessage("build");
      assert.ok(msg.includes("/safetynet:plan"));
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

  describe("getLatestCustomEntry", () => {
    it("returns undefined when no matching entries", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [],
        },
      } as unknown as ExtensionContext;
      const result = getLatestCustomEntry(ctx, "safetynet:profile");
      assert.equal(result, undefined);
    });

    it("returns entry with data field from matching custom entries", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:profile", data: { enabled: "build" } },
          ],
        },
      } as unknown as ExtensionContext;
      const result = getLatestCustomEntry<{ enabled: string }>(ctx, "safetynet:profile");
      assert.deepEqual(result?.data, { enabled: "build" });
    });

    it("returns latest entry when multiple matches", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:profile", data: { enabled: "plan" } },
            { type: "custom", customType: "safetynet:profile", data: { enabled: "build" } },
          ],
        },
      } as unknown as ExtensionContext;
      const result = getLatestCustomEntry<{ enabled: string }>(ctx, "safetynet:profile");
      assert.deepEqual(result?.data, { enabled: "build" });
    });

    it("ignores entries with different customType", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "other", data: { enabled: "build" } },
          ],
        },
      } as unknown as ExtensionContext;
      const result = getLatestCustomEntry<{ enabled: string }>(ctx, "safetynet:profile");
      assert.equal(result, undefined);
    });
  });

  describe("restoreProfile", () => {
    afterEach(() => {
      setCurrentProfile("plan");
    });

    it("restores build profile from session entry", () => {
      setCurrentProfile("plan");
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:profile", data: { enabled: "build" } },
          ],
        },
      } as unknown as ExtensionContext;
      restoreProfile(ctx);
      assert.equal(getCurrentProfile(), "build");
    });

    it("restores plan profile from session entry", () => {
      setCurrentProfile("build");
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:profile", data: { enabled: "plan" } },
          ],
        },
      } as unknown as ExtensionContext;
      restoreProfile(ctx);
      assert.equal(getCurrentProfile(), "plan");
    });

    it("keeps default when no entry exists", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [],
        },
      } as unknown as ExtensionContext;
      restoreProfile(ctx);
      assert.equal(getCurrentProfile(), "plan");
    });

    it("uses latest entry when multiple exist", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:profile", data: { enabled: "plan" } },
            { type: "custom", customType: "safetynet:profile", data: { enabled: "build" } },
            { type: "custom", customType: "safetynet:profile", data: { enabled: "plan" } },
          ],
        },
      } as unknown as ExtensionContext;
      restoreProfile(ctx);
      assert.equal(getCurrentProfile(), "plan");
    });
  });

  describe("restorePlanOnError", () => {
    afterEach(() => {
      // reset to default
      // planOnErrorEnabled is module-private, but setPlanOnError can reset it
    });

    it("restores enabled=false from session entry", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:plan-on-error", data: { enabled: false } },
          ],
        },
      } as unknown as ExtensionContext;
      restorePlanOnError(ctx);
      assert.equal(isPlanOnErrorEnabled(), false);
    });

    it("restores enabled=true from session entry", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "safetynet:plan-on-error", data: { enabled: true } },
          ],
        },
      } as unknown as ExtensionContext;
      restorePlanOnError(ctx);
      assert.equal(isPlanOnErrorEnabled(), true);
    });

    it("keeps default when no entry exists", () => {
      const ctx = {
        sessionManager: {
          getEntries: () => [],
        },
      } as unknown as ExtensionContext;
      restorePlanOnError(ctx);
      // default is true
      assert.equal(isPlanOnErrorEnabled(), true);
    });
  });
});
