import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getCurrentProfile,
  setCurrentProfile,
  MODE_REMINDER_CUSTOM_TYPE,
  STATIC_SYSTEM_PROMPT_BLOCK,
  getModeSwitchMessage,
  getSessionModeMessage,
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

  describe("STATIC_SYSTEM_PROMPT_BLOCK", () => {
    it("is a non-empty string", () => {
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.length > 0);
    });

    it("contains the Permissions section with the ruleset", () => {
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("## Permissions"));
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("Allowlisted commands run silently"));
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("Unknown commands prompt the user for approval"));
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("Dangerous commands are blocked"));
    });

    it("mentions the mode toggle", () => {
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("toggle between read-only and read-write mode"));
    });

    it("contains the Subagents section", () => {
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("## Subagents"));
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("subagent_explore"));
      assert.ok(STATIC_SYSTEM_PROMPT_BLOCK.includes("subagent_build"));
    });

    it("is mode-independent and constant", () => {
      assert.equal(STATIC_SYSTEM_PROMPT_BLOCK, STATIC_SYSTEM_PROMPT_BLOCK);
      // Byte-identical across turns — no per-turn injection, no template state.
      assert.ok(!STATIC_SYSTEM_PROMPT_BLOCK.includes("${profile}"));
    });
  });

  describe("getModeSwitchMessage", () => {
    it("read-only profiles get the read-only switch message", () => {
      for (const p of ["ro", "plan"] as const) {
        const msg = getModeSwitchMessage(p);
        assert.ok(msg.includes("<system-reminder>"));
        assert.ok(msg.includes("switched you to read-only mode"));
        assert.ok(msg.includes("only inspect and read"));
      }
    });

    it("write profiles get the read-write switch message", () => {
      for (const p of ["rw", "build"] as const) {
        const msg = getModeSwitchMessage(p);
        assert.ok(msg.includes("<system-reminder>"));
        assert.ok(msg.includes("switched you to read-write mode"));
        assert.ok(msg.includes("run commands and modify files"));
      }
    });
  });

  describe("getSessionModeMessage", () => {
    it("read-only profiles announce a read-only session", () => {
      for (const p of ["ro", "plan"] as const) {
        const msg = getSessionModeMessage(p);
        assert.ok(msg.includes("<system-reminder>"));
        assert.ok(msg.includes("This session is in read-only mode"));
      }
    });

    it("write profiles announce a read-write session", () => {
      for (const p of ["rw", "build"] as const) {
        const msg = getSessionModeMessage(p);
        assert.ok(msg.includes("<system-reminder>"));
        assert.ok(msg.includes("This session is in read-write mode"));
      }
    });
  });

  describe("MODE_REMINDER_CUSTOM_TYPE", () => {
    it("is defined", () => {
      assert.ok(MODE_REMINDER_CUSTOM_TYPE.length > 0);
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
