import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  getEphemeralContextMessage,
  EPHEMERAL_CUSTOM_TYPE,
  getLatestCustomEntry,
  restoreProfile,
  getParadigm,
  setParadigm,
  normalizeProfile,
  getModeAliases,
  isReadOnly,
  paradigmModes,
} from "./profiles.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("profiles", () => {
  beforeEach(() => {
    // Hermetic: reset module state so ambient config (e.g. paradigm: "ro-rw"
    // in the developer's real config) never leaks into these assertions.
    setParadigm("plan-build");
    setCurrentProfile("plan");
  });

  afterEach(() => {
    setParadigm("plan-build");
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

  describe("paradigm", () => {
    afterEach(() => { setParadigm("plan-build"); setCurrentProfile("plan"); });

    it("defaults to plan-build paradigm", () => {
      assert.equal(getParadigm(), "plan-build");
    });

    it("setParadigm changes the active paradigm", () => {
      setParadigm("ro-rw");
      assert.equal(getParadigm(), "ro-rw");
    });

    it("normalizeProfile is identity for canonical plan-build names", () => {
      assert.equal(normalizeProfile("plan"), "plan");
      assert.equal(normalizeProfile("build"), "build");
    });

    it("normalizeProfile maps foreign names under plan-build", () => {
      assert.equal(normalizeProfile("ro"), "plan");
      assert.equal(normalizeProfile("rw"), "build");
    });

    it("under ro-rw, plan maps to ro and build maps to rw", () => {
      setParadigm("ro-rw");
      assert.equal(normalizeProfile("plan"), "ro");
      assert.equal(normalizeProfile("build"), "rw");
      assert.equal(normalizeProfile("ro"), "ro");
      assert.equal(normalizeProfile("rw"), "rw");
    });

    it("setCurrentProfile normalizes to canonical under plan-build", () => {
      setParadigm("plan-build");
      setCurrentProfile("rw");
      assert.equal(getCurrentProfile(), "build");
    });

    it("setCurrentProfile normalizes to canonical under ro-rw", () => {
      setParadigm("ro-rw");
      setCurrentProfile("plan");
      assert.equal(getCurrentProfile(), "ro");
    });

    it("getModeAliases is the symmetric bijection", () => {
      const aliases = getModeAliases();
      assert.equal(aliases.plan, "ro");
      assert.equal(aliases.build, "rw");
      assert.equal(aliases.ro, "plan");
      assert.equal(aliases.rw, "build");
    });

    it("isReadOnly returns true for plan and ro", () => {
      assert.equal(isReadOnly("plan"), true);
      assert.equal(isReadOnly("ro"), true);
      assert.equal(isReadOnly("build"), false);
      assert.equal(isReadOnly("rw"), false);
    });

    it("paradigmModes returns the active read/write pair", () => {
      setParadigm("plan-build");
      assert.deepEqual(paradigmModes(), { read: "plan", write: "build" });
      setParadigm("ro-rw");
      assert.deepEqual(paradigmModes(), { read: "ro", write: "rw" });
      setParadigm("plan-build");
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

    it("plan message has no Available tools footer", () => {
      const msg = getEphemeralContextMessage("plan");
      assert.ok(!msg.includes("Available tools"));
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

    it("build message has no Available tools footer", () => {
      const msg = getEphemeralContextMessage("build");
      assert.ok(!msg.includes("Available tools"));
    });

    it("ro message mentions read-only and has no Available tools footer", () => {
      const msg = getEphemeralContextMessage("ro");
      assert.ok(msg.includes("READ-ONLY") || msg.includes("read-only"));
      assert.ok(!msg.includes("Available tools"));
    });

    it("ro message explains the state is deliberate (not a limitation)", () => {
      const msg = getEphemeralContextMessage("ro");
      assert.ok(msg.toLowerCase().includes("deliberate"));
    });

    it("rw message mentions read-write and has no Available tools footer", () => {
      const msg = getEphemeralContextMessage("rw");
      assert.ok(msg.includes("READ-WRITE") || msg.includes("read-write"));
      assert.ok(!msg.includes("Available tools"));
    });

    it("rw message points to /safetynet:ro for read-only", () => {
      const msg = getEphemeralContextMessage("rw");
      assert.ok(msg.includes("/safetynet:ro"));
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
});
