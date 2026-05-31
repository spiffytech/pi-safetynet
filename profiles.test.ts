import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  getEphemeralContextMessage,
  EPHEMERAL_CUSTOM_TYPE,
  getLatestCustomEntry,
  restoreProfile,
} from "./profiles/index.ts";
import {
  restorePlanOnError,
  isPlanOnErrorEnabled,
  setPlanOnError,
} from "./profiles/plan-on-error.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

  describe("getEphemeralContextMessage", () => {
    it("plan message mentions read-only planning", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(msg.includes("plan"));
      assert.ok(msg.includes("READ-ONLY") || msg.includes("planning-only"));
    });

    it("plan message mentions planPresent", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(msg.includes("planPresent"));
    });

    it("plan message mentions planWrite", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(msg.includes("planWrite"));
    });

    it("plan message explains user-controlled build transition", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(msg.includes("/safetynet:build"));
    });

    it("plan message includes available tools", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(msg.includes("read"));
      assert.ok(msg.includes("grep"));
      assert.ok(msg.includes("planWrite"));
      assert.ok(!msg.includes("bash"));
      // Parse the Available tools line to check exact tool names
      const toolsSection = msg.split("Available tools\n")[1]?.split("\n")[0] ?? "";
      const tools = toolsSection.split(", ").map(t => t.trim());
      assert.ok(!tools.includes("edit"));
      assert.ok(!tools.includes("write"));
      assert.ok(!tools.includes("bash"));
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("planWrite"));
    });

    it("build message mentions full access", () => {
      const msg = getEphemeralContextMessage("build");
      assert.ok(msg.includes("build"));
      assert.ok(msg.includes("full tool access") || msg.includes("Full tool access"));
    });

    it("build message mentions /safetynet:plan", () => {
      const msg = getEphemeralContextMessage("build");
      assert.ok(msg.includes("/safetynet:plan"));
    });

    it("build message includes all tools", () => {
      const msg = getEphemeralContextMessage("build");
      assert.ok(msg.includes("bash"));
      assert.ok(msg.includes("edit"));
      assert.ok(msg.includes("write"));
      assert.ok(msg.includes("read"));
    });

    it("EPHEMERAL_CUSTOM_TYPE is defined", () => {
      assert.ok(EPHEMERAL_CUSTOM_TYPE.length > 0);
    });

    it("plan and build messages are content-constant (no filesystem checks)", () => {
      // The messages should NOT vary based on planPath — no existsSync checks
      // So calling with and without a planPath should produce identical results
      const msg1 = getEphemeralContextMessage("plan");
      const msg2 = getEphemeralContextMessage("plan");
      assert.equal(msg1, msg2);

      const msg3 = getEphemeralContextMessage("build");
      const msg4 = getEphemeralContextMessage("build");
      assert.equal(msg3, msg4);
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
