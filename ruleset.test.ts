import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bashPatternToRegex,
  matchesPattern,
  evaluatePermission,
} from "./permissions/ruleset.ts";
import type { Rule, Ruleset, ProfileName } from "./types.ts";
import baselineData from "./permissions/baseline.json" with { type: "json" };

const BASELINE: Ruleset = baselineData.rules as Ruleset;
const ALL_MODES: ProfileName[] = ["build", "plan"];

describe("bashPatternToRegex", () => {
  it("matches exact string for pattern with no wildcards", () => {
    const re = bashPatternToRegex("pwd");
    assert.match("pwd", re);
    assert.doesNotMatch("pwdx", re);
    assert.doesNotMatch("ls pwd", re);
  });

  it("matches any string for * pattern", () => {
    const re = bashPatternToRegex("*");
    assert.match("ls", re);
    assert.match("hostname", re);
    assert.match("git status", re);
  });

  it("matches command with optional args for ' *' pattern", () => {
    const re = bashPatternToRegex("ls *");
    assert.match("ls", re);
    assert.match("ls -la", re);
    assert.match("ls /tmp", re);
    assert.doesNotMatch("lsabc", re);
  });

  it("matches command with args for ' *' pattern where args are required", () => {
    const re = bashPatternToRegex("cat *");
    assert.match("cat file.txt", re);
    assert.match("cat", re);
  });

  it("matches git subcommands with ' *' pattern", () => {
    const re = bashPatternToRegex("git status *");
    assert.match("git status", re);
    assert.match("git status --short", re);
    assert.doesNotMatch("git log", re);
    assert.doesNotMatch("gitstatus", re);
  });

  it("escapes regex metacharacters in pattern", () => {
    const re = bashPatternToRegex("node -e *");
    assert.match("node -e 'console.log(1)'", re);
    assert.match("node -e", re);
    assert.doesNotMatch("nodex", re);
  });

  it("matches 'sed -n *' pattern", () => {
    const re = bashPatternToRegex("sed -n *");
    assert.match("sed -n '1p' file.txt", re);
    assert.match("sed -n", re);
  });

  it("handles pattern that is just * at start without space", () => {
    const re = bashPatternToRegex("*.log");
    assert.match("error.log", re);
    assert.match("debug.log", re);
    assert.doesNotMatch("error.txt", re);
  });
});

describe("matchesPattern", () => {
  describe("bash patterns", () => {
    it("matches bash patterns using regex", () => {
      assert.equal(matchesPattern("bash", "ls *", "ls"), true);
      assert.equal(matchesPattern("bash", "ls *", "ls -la"), true);
      assert.equal(matchesPattern("bash", "ls *", "lsabc"), false);
    });

    it("matches exact bash commands", () => {
      assert.equal(matchesPattern("bash", "pwd", "pwd"), true);
      assert.equal(matchesPattern("bash", "pwd", "pwdx"), false);
    });

    it("matches * catch-all for bash", () => {
      assert.equal(matchesPattern("bash", "*", "hostname"), true);
      assert.equal(matchesPattern("bash", "*", "anything"), true);
    });
  });

  describe("file patterns (edit/read)", () => {
    it("uses picomatch for edit patterns with path separators", () => {
      assert.equal(matchesPattern("edit", "**", "src/main.ts"), true);
    });

    it("uses picomatch for read patterns", () => {
      assert.equal(matchesPattern("read", "**", "src/main.ts"), true);
    });

    it("matches glob star patterns for files", () => {
      assert.equal(matchesPattern("edit", "*.ts", "foo.ts"), true);
      assert.equal(matchesPattern("edit", "*.ts", "foo.js"), false);
    });

    it("matches dotfiles (isHazardousFile blocks .env/etc upstream, not ruleset)", () => {
      assert.equal(matchesPattern("edit", "**", ".env"), true);
      assert.equal(matchesPattern("edit", "**", ".gitignore"), true);
      assert.equal(matchesPattern("edit", "**", "src/main.ts"), true);
    });
  });

  describe("wildcard permission", () => {
    it("* permission matches bash patterns", () => {
      assert.equal(matchesPattern("*", "ls *", "ls"), true);
    });

    it("* permission matches file patterns", () => {
      assert.equal(matchesPattern("*", "**", "src/main.ts"), true);
    });
  });
});

describe("evaluatePermission", () => {
  describe("with baseline rules", () => {
    it("allows ls in build mode", () => {
      const result = evaluatePermission("bash", "ls", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows cat in build mode", () => {
      const result = evaluatePermission("bash", "cat", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows git status in build mode", () => {
      const result = evaluatePermission("bash", "git status", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows pwd in build mode", () => {
      const result = evaluatePermission("bash", "pwd", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows echo in build mode", () => {
      const result = evaluatePermission("bash", "echo", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows whoami in build mode", () => {
      const result = evaluatePermission("bash", "whoami", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows date in build mode", () => {
      const result = evaluatePermission("bash", "date", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("returns ask for hostname in build mode", () => {
      const result = evaluatePermission("bash", "hostname", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for unknown commands in build mode", () => {
      const result = evaluatePermission("bash", "python3", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for npm install in build mode", () => {
      const result = evaluatePermission("bash", "npm install", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("allows ls in plan mode (baseline allows with modes: build+plan)", () => {
      const result = evaluatePermission("bash", "ls", "plan", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows cat in plan mode", () => {
      const result = evaluatePermission("bash", "cat", "plan", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows git status in plan mode", () => {
      const result = evaluatePermission("bash", "git status", "plan", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("returns ask for unknown commands in plan mode (ask-by-default)", () => {
      const result = evaluatePermission("bash", "hostname", "plan", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for edit in plan mode (ask-by-default)", () => {
      const result = evaluatePermission("edit", "src/main.ts", "plan", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for edit in build mode", () => {
      const result = evaluatePermission("edit", "src/main.ts", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("allows read in build mode", () => {
      const result = evaluatePermission("read", "src/main.ts", "build", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("allows read in plan mode", () => {
      const result = evaluatePermission("read", "src/main.ts", "plan", BASELINE);
      assert.equal(result.action, "allow");
    });

    it("returns ask for tee in build mode (file-writing command)", () => {
      const result = evaluatePermission("bash", "tee out.txt", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for tee in plan mode", () => {
      const result = evaluatePermission("bash", "tee out.txt", "plan", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for cp in build mode (file-writing command)", () => {
      const result = evaluatePermission("bash", "cp src dst", "build", BASELINE);
      assert.equal(result.action, "ask");
    });

    it("returns ask for mv in build mode (file-writing command)", () => {
      const result = evaluatePermission("bash", "mv old new", "build", BASELINE);
      assert.equal(result.action, "ask");
    });
  });

  describe("rule ordering (last match wins)", () => {
    it("a later allow rule overrides an earlier deny", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "deny", modes: ALL_MODES },
        { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES },
      ];
      const result = evaluatePermission("bash", "ls", "build", rules);
      assert.equal(result.action, "allow");
    });

    it("a later deny rule overrides an earlier allow", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES },
        { permission: "bash", pattern: "ls *", action: "deny", modes: ALL_MODES },
      ];
      const result = evaluatePermission("bash", "ls", "build", rules);
      assert.equal(result.action, "deny");
    });

    it("session rules override persisted rules override baseline", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ["build", "plan"] },
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build"] },
      ];
      const result = evaluatePermission("bash", "hostname", "build", rules);
      assert.equal(result.action, "allow");
    });
  });

  describe("modes filtering", () => {
    it("skips rule when modes do not include current profile", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["plan"] },
        { permission: "bash", pattern: "*", action: "ask", modes: ["build", "plan"] },
      ];
      const result = evaluatePermission("bash", "hostname", "build", rules);
      assert.equal(result.action, "ask");
    });

    it("applies rule when modes include current profile", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build"] },
      ];
      const result = evaluatePermission("bash", "hostname", "build", rules);
      assert.equal(result.action, "allow");
    });

    it("deny action applies when modes include current profile", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "deny", modes: ALL_MODES },
      ];
      assert.equal(evaluatePermission("bash", "anything", "build", rules).action, "deny");
      assert.equal(evaluatePermission("bash", "anything", "plan", rules).action, "deny");
    });

    it("build-only rule is invisible to plan mode", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build"] },
      ];
      assert.equal(evaluatePermission("bash", "hostname", "build", rules).action, "allow");
      assert.equal(evaluatePermission("bash", "hostname", "plan", rules).action, "ask");
    });

    it("plan+build rule applies in both profiles", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build", "plan"] },
      ];
      assert.equal(evaluatePermission("bash", "hostname", "build", rules).action, "allow");
      assert.equal(evaluatePermission("bash", "hostname", "plan", rules).action, "allow");
    });
  });

  describe("wildcard permission *", () => {
    it("rule with permission * matches bash check", () => {
      const rules: Ruleset = [
        { permission: "*", pattern: "hostname", action: "allow", modes: ALL_MODES },
      ];
      const result = evaluatePermission("bash", "hostname", "build", rules);
      assert.equal(result.action, "allow");
    });

    it("rule with permission * matches edit check", () => {
      const rules: Ruleset = [
        { permission: "*", pattern: "**", action: "deny", modes: ALL_MODES },
      ];
      const result = evaluatePermission("edit", "anything", "build", rules);
      assert.equal(result.action, "deny");
    });

    it("rule with permission * matches read check", () => {
      const rules: Ruleset = [
        { permission: "*", pattern: "**", action: "allow", modes: ALL_MODES },
      ];
      const result = evaluatePermission("read", "anything", "build", rules);
      assert.equal(result.action, "allow");
    });
  });

  describe("default fallback", () => {
    it("returns deny when ruleset is empty (misconfiguration guard)", () => {
      const rules: Ruleset = [];
      assert.equal(evaluatePermission("bash", "anything", "plan", rules).action, "deny");
      assert.equal(evaluatePermission("bash", "anything", "build", rules).action, "deny");
      assert.equal(evaluatePermission("edit", "anything", "build", rules).action, "deny");
    });

    it("returns ask when rules exist but none match the target", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES },
      ];
      assert.equal(evaluatePermission("bash", "hostname", "build", rules).action, "ask");
      assert.equal(evaluatePermission("bash", "hostname", "plan", rules).action, "ask");
    });
  });

  describe("forward compatibility: new profile mode with no rules", () => {
    it("returns ask for bash when no rules include the current mode", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "ls *", action: "allow", modes: ["build", "plan"] },
        { permission: "bash", pattern: "*", action: "ask", modes: ["build", "plan"] },
      ];
      const result = evaluatePermission("bash", "ls", "review" as ProfileName, rules);
      assert.equal(result.action, "ask");
    });

    it("returns ask for edit when no rules include the current mode", () => {
      const rules: Ruleset = [
        { permission: "edit", pattern: "**", action: "ask", modes: ["build", "plan"] },
      ];
      const result = evaluatePermission("edit", "src/main.ts", "review" as ProfileName, rules);
      assert.equal(result.action, "ask");
    });

    it("returns deny when ruleset is completely empty regardless of mode", () => {
      const result = evaluatePermission("bash", "anything", "review" as ProfileName, []);
      assert.equal(result.action, "deny");
    });

    it("still respects rules that explicitly include the new mode", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "ls *", action: "allow", modes: ["build", "plan", "review"] as ProfileName[] },
        { permission: "bash", pattern: "*", action: "ask", modes: ["build", "plan"] },
      ];
      const result = evaluatePermission("bash", "ls", "review" as ProfileName, rules);
      assert.equal(result.action, "allow");
    });

    it("falls through to ask when explicit mode rule does not match target", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "ls *", action: "allow", modes: ["build", "plan", "review"] as ProfileName[] },
        { permission: "bash", pattern: "*", action: "ask", modes: ["build", "plan"] },
      ];
      const result = evaluatePermission("bash", "hostname", "review" as ProfileName, rules);
      assert.equal(result.action, "ask");
    });
  });

  describe("matchedRule tracking", () => {
    it("returns the matched rule in result", () => {
      const rule: Rule = { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES };
      const rules: Ruleset = [rule];
      const result = evaluatePermission("bash", "ls", "build", rules);
      assert.equal(result.matchedRule, rule);
    });

    it("returns undefined matchedRule when falling back to default", () => {
      const rules: Ruleset = [];
      const result = evaluatePermission("bash", "anything", "build", rules);
      assert.equal(result.matchedRule, undefined);
    });
  });
});
