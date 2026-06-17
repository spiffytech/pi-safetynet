import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalRules, saveGlobalRules, addGlobalRules, getGlobalConfigPath, getGlobalConfigDir, loadDefaultProfile, saveDefaultProfile, loadTrustExternalPaths } from "./global-config.ts";
import type { Ruleset } from "./types.ts";

/** Temporary homedir override for testing. */
const TMP_HOME = join(process.cwd(), ".test-tmp-home");

const originalHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = TMP_HOME;
  // Clean slate
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  mkdirSync(TMP_HOME, { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
});

describe("global-config", () => {
  describe("getGlobalConfigDir / getGlobalConfigPath", () => {
    it("returns ~/.config/pi-safetynet/ for dir", () => {
      assert.equal(getGlobalConfigDir(), join(TMP_HOME, ".config", "pi-safetynet"));
    });

    it("returns ~/.config/pi-safetynet/config.json for path", () => {
      assert.equal(getGlobalConfigPath(), join(TMP_HOME, ".config", "pi-safetynet", "config.json"));
    });
  });

  describe("loadGlobalRules", () => {
    it("returns empty array when config file does not exist", () => {
      assert.deepEqual(loadGlobalRules(), []);
    });

    it("returns empty array when config file has no rules key", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ otherKey: 42 }), "utf-8");

      assert.deepEqual(loadGlobalRules(), []);
    });

    it("returns empty array when rules is not an array", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ rules: "not an array" }), "utf-8");

      assert.deepEqual(loadGlobalRules(), []);
    });

    it("loads valid rules from config file", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      const rules: Ruleset = [
        { permission: "bash", pattern: "npm test", action: "allow", modes: ["build", "plan"] },
      ];
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ rules }), "utf-8");

      assert.deepEqual(loadGlobalRules(), rules);
    });

    it("sanitizes invalid rules from config file", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({
        rules: [
          { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
          { permission: "invalid", pattern: "bad", action: "allow", modes: ["build"] },
          { permission: "bash", pattern: "good", action: "allow" }, // missing modes
        ],
      }), "utf-8");

      assert.deepEqual(loadGlobalRules(), [
        { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
      ]);
    });

    it("returns empty array for unparseable JSON", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), "not json{{{", "utf-8");

      assert.deepEqual(loadGlobalRules(), []);
    });
  });

  describe("saveGlobalRules", () => {
    it("creates the config directory and file if they don't exist", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
      ];
      saveGlobalRules(rules);

      assert.ok(existsSync(getGlobalConfigPath()));
      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.deepEqual(parsed.rules, rules);
    });

    it("preserves other keys in the config file", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({
        futureKey: "futureValue",
        rules: [{ permission: "bash", pattern: "old", action: "allow", modes: ["build"] }],
      }), "utf-8");

      const newRules: Ruleset = [
        { permission: "bash", pattern: "new", action: "allow", modes: ["plan"] },
      ];
      saveGlobalRules(newRules);

      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.equal(parsed.futureKey, "futureValue");
      assert.deepEqual(parsed.rules, newRules);
    });
  });

  describe("addGlobalRules", () => {
    it("appends rules to existing ones", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      const existing: Ruleset = [
        { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
      ];
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ rules: existing }), "utf-8");

      const result = addGlobalRules([
        { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
      ]);

      assert.deepEqual(result, [
        { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
        { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
      ]);

      // Also verify on disk
      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.deepEqual(parsed.rules, result);
    });

    it("creates config file if it doesn't exist", () => {
      const result = addGlobalRules([
        { permission: "bash", pattern: "cargo test", action: "allow", modes: ["build", "plan"] },
      ]);

      assert.deepEqual(result, [
        { permission: "bash", pattern: "cargo test", action: "allow", modes: ["build", "plan"] },
      ]);
      assert.ok(existsSync(getGlobalConfigPath()));
    });

    it("preserves non-rules keys when adding", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({
        otherConfig: true,
        rules: [{ permission: "bash", pattern: "old", action: "allow", modes: ["build"] }],
      }), "utf-8");

      addGlobalRules([
        { permission: "bash", pattern: "new", action: "allow", modes: ["build"] },
      ]);

      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.equal(parsed.otherConfig, true);
      assert.equal(parsed.rules.length, 2);
    });
  });

  describe("loadDefaultProfile", () => {
    it("returns undefined when config file does not exist", () => {
      assert.equal(loadDefaultProfile(), undefined);
    });

    it("returns undefined when config file has no defaultProfile key", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ rules: [] }), "utf-8");

      assert.equal(loadDefaultProfile(), undefined);
    });

    it("returns undefined for invalid defaultProfile value", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ defaultProfile: "invalid" }), "utf-8");

      assert.equal(loadDefaultProfile(), undefined);
    });

    it("returns 'plan' when defaultProfile is 'plan'", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ defaultProfile: "plan" }), "utf-8");

      assert.equal(loadDefaultProfile(), "plan");
    });

    it("returns 'build' when defaultProfile is 'build'", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ defaultProfile: "build" }), "utf-8");

      assert.equal(loadDefaultProfile(), "build");
    });
  });

  describe("loadTrustExternalPaths", () => {
    it("returns false when config file does not exist", () => {
      assert.equal(loadTrustExternalPaths(), false);
    });

    it("returns false when config file has no trustExternalPaths key", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ rules: [] }), "utf-8");

      assert.equal(loadTrustExternalPaths(), false);
    });

    it("returns false for a non-boolean value", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ trustExternalPaths: "yes" }), "utf-8");

      assert.equal(loadTrustExternalPaths(), false);
    });

    it("returns false when trustExternalPaths is false", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ trustExternalPaths: false }), "utf-8");

      assert.equal(loadTrustExternalPaths(), false);
    });

    it("returns true when trustExternalPaths is true", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({ trustExternalPaths: true }), "utf-8");

      assert.equal(loadTrustExternalPaths(), true);
    });
  });

  describe("saveDefaultProfile", () => {
    it("creates config file with defaultProfile if it doesn't exist", () => {
      saveDefaultProfile("build");

      assert.ok(existsSync(getGlobalConfigPath()));
      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.equal(parsed.defaultProfile, "build");
    });

    it("preserves other keys when saving defaultProfile", () => {
      const dir = getGlobalConfigDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(getGlobalConfigPath(), JSON.stringify({
        rules: [{ permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] }],
        subagents: ["subagent_explore"],
      }), "utf-8");

      saveDefaultProfile("plan");

      const parsed = JSON.parse(readFileSync(getGlobalConfigPath(), "utf-8"));
      assert.equal(parsed.defaultProfile, "plan");
      assert.deepEqual(parsed.rules, [{ permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] }]);
      assert.deepEqual(parsed.subagents, ["subagent_explore"]);
    });
  });
});
