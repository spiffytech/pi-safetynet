import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bashPatternToRegex,
  matchesPattern,
  evaluatePermission,
} from "./permissions/ruleset.ts";
import type { Rule, Ruleset, ProfileName } from "./types.ts";
import baselineData from "./permissions/baseline.json" with { type: "json" };
import { checkBashPermission, checkFileTarget } from "./check.ts";
import { toRecursiveGlob, normalizePathForMatching } from "./project.ts";

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

    it("matches '.' (project root) against '**'", () => {
      // '.' is what normalizePathForMatching returns for the project root itself.
      // picomatch("**")(".") returns false, but semantically the root IS
      // contained within ** — it is the zero-segment match.
      assert.equal(matchesPattern("read", "**", "."), true);
      assert.equal(matchesPattern("edit", "**", "."), true);
    });

    it("does NOT match '.' against non-** patterns", () => {
      assert.equal(matchesPattern("read", "*.ts", "."), false);
      assert.equal(matchesPattern("read", "src/*", "."), false);
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
    it("every baseline allow rule actually allows matching targets", () => {
      for (const rule of BASELINE) {
        if (rule.action !== "allow") continue;
        const bare = rule.pattern.replace(/ \*$/, "");
        const targets = bare === rule.pattern
          ? [rule.pattern]
          : [bare, `${bare} --arg`];
        for (const target of targets) {
          for (const mode of rule.modes) {
            assert.equal(
              evaluatePermission(rule.permission as never, target, mode, BASELINE).action,
              "allow",
              `${rule.permission}:${rule.pattern} should allow "${target}" in ${mode}`,
            );
          }
        }
      }
    });

    it("returns ask for unknown bash commands (catch-all * rule)", () => {
      assert.equal(evaluatePermission("bash", "gcc", "build", BASELINE).action, "ask");
      assert.equal(evaluatePermission("bash", "gcc", "plan", BASELINE).action, "ask");
      assert.equal(evaluatePermission("bash", "python3", "build", BASELINE).action, "ask");
    });

    it("multi-word patterns: sed -n allowed, npm install asked, git config --get allowed", () => {
      assert.equal(evaluatePermission("bash", "sed -n", "build", BASELINE).action, "allow");
      assert.equal(evaluatePermission("bash", "npm install", "build", BASELINE).action, "ask");
      assert.equal(evaluatePermission("bash", "git config --get", "build", BASELINE).action, "allow");
    });

    it("printf is allowed by baseline", () => {
      assert.equal(evaluatePermission("bash", "printf '\\nPackage:\\n'", "build", BASELINE).action, "allow");
    });

    it("[ test is allowed by baseline", () => {
      assert.equal(evaluatePermission("bash", "[ -f package.json ]", "build", BASELINE).action, "allow");
    });

    it("[[ test is allowed by baseline", () => {
      assert.equal(evaluatePermission("bash", "[[ -f package.json ]]", "build", BASELINE).action, "allow");
    });

    it("diff is allowed by baseline", () => {
      assert.equal(evaluatePermission("bash", "diff file1.txt file2.txt", "build", BASELINE).action, "allow");
    });

    it("true/false/yes are allowed by baseline", () => {
      assert.equal(evaluatePermission("bash", "true", "build", BASELINE).action, "allow");
      assert.equal(evaluatePermission("bash", "false", "build", BASELINE).action, "allow");
      assert.equal(evaluatePermission("bash", "yes", "build", BASELINE).action, "allow");
    });

    it("ask rules for file-writing commands", () => {
      assert.equal(evaluatePermission("bash", "tee out.txt", "build", BASELINE).action, "ask");
      assert.equal(evaluatePermission("bash", "cp src dst", "build", BASELINE).action, "ask");
      assert.equal(evaluatePermission("bash", "mv old new", "build", BASELINE).action, "ask");
    });

    it("file permissions: edit asks, read allows", () => {
      assert.equal(evaluatePermission("edit", "src/main.ts", "build", BASELINE).action, "ask");
      assert.equal(evaluatePermission("edit", "src/main.ts", "plan", BASELINE).action, "ask");
      assert.equal(evaluatePermission("read", "src/main.ts", "build", BASELINE).action, "allow");
      assert.equal(evaluatePermission("read", "src/main.ts", "plan", BASELINE).action, "allow");
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

    it("denylist: allow * then deny specific pattern overrides the catch-all", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "allow", modes: ALL_MODES },
        { permission: "bash", pattern: "rm *", action: "deny", modes: ALL_MODES },
      ];
      assert.equal(evaluatePermission("bash", "curl", "build", rules).action, "allow");
      assert.equal(evaluatePermission("bash", "rm file.txt", "build", rules).action, "deny");
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

describe("composition: bash permission end-to-end", () => {
  describe("catastrophic commands short-circuit to deny", () => {
    it("denies catastrophic commands regardless of profile", () => {
      assert.equal(checkBashPermission("rm -rf /", "build", BASELINE).action, "deny");
      assert.equal(checkBashPermission("rm -rf /", "plan", BASELINE).action, "deny");
    });

    it("denies rm -rf /tmp in build mode", () => {
      assert.equal(checkBashPermission("rm -rf /tmp", "build", BASELINE).action, "deny");
    });

    it("denies chown on protected dir", () => {
      assert.equal(checkBashPermission("chown root /etc", "build", BASELINE).action, "deny");
    });

    it("denies rm with double-quoted protected dir", () => {
      assert.equal(checkBashPermission('rm "/etc"', "build", BASELINE).action, "deny");
      assert.equal(checkBashPermission('rm "/usr"', "plan", BASELINE).action, "deny");
    });
  });

  describe("subcommand extraction: pipes and sudo", () => {
    it("returns ask for piped commands when neither subcommand is allowlisted", () => {
      // Neither "curl" nor "python3" has a baseline allow rule;
      // each matches the * catch-all (ask). This proves the pipeline
      // is split and each subcommand is individually evaluated.
      const result = checkBashPermission("curl | python3", "build", BASELINE);
      assert.equal(result.action, "ask");
      assert.deepEqual(result.unapproved, ["curl", "python3"]);
    });

    it("allows piped commands when both subcommands match allow rules", () => {
      assert.equal(checkBashPermission("ls | grep foo", "build", BASELINE).action, "allow");
    });

    it("returns ask for xargs in pipeline", () => {
      assert.equal(checkBashPermission("find . -name '*.ts' | xargs rm", "build", BASELINE).action, "ask");
    });

    it("returns ask for sudo rm file.txt in build mode", () => {
      assert.equal(checkBashPermission("sudo rm file.txt", "build", BASELINE).action, "ask");
    });

    it("returns ask for sudo ls in build mode (sudo is never allowlisted)", () => {
      assert.equal(checkBashPermission("sudo ls", "build", BASELINE).action, "ask");
    });

    it("denies sudo rm -rf / regardless of profile", () => {
      assert.equal(checkBashPermission("sudo rm -rf /", "build", BASELINE).action, "deny");
      assert.equal(checkBashPermission("sudo rm -rf /", "plan", BASELINE).action, "deny");
    });

    it("denies sudo chown on protected dir", () => {
      assert.equal(checkBashPermission("sudo chown root /etc", "build", BASELINE).action, "deny");
    });

    it("denies sudo chmod on protected dir", () => {
      assert.equal(checkBashPermission("sudo chmod 777 /usr", "build", BASELINE).action, "deny");
    });

    it("denies sudo with flags before command (sudo -u root rm /etc)", () => {
      assert.equal(checkBashPermission("sudo -u root rm /etc", "build", BASELINE).action, "deny");
    });

    it("denies sudo -E chown on protected dir", () => {
      assert.equal(checkBashPermission("sudo -E chown root /usr", "build", BASELINE).action, "deny");
    });
  });

  describe("empty-quoted arguments match allow rules", () => {
    it("allows echo with empty double-quoted arg", () => {
      assert.equal(checkBashPermission('echo ""', "build", BASELINE).action, "allow");
    });

    it("allows echo with empty single-quoted arg", () => {
      assert.equal(checkBashPermission("echo ''", "build", BASELINE).action, "allow");
    });

    it("allows multi-subcommand chain containing echo \"\"", () => {
      assert.equal(checkBashPermission('echo "" && grep foo bar', "build", BASELINE).action, "allow");
    });
  });

  describe("find -exec/-delete composition", () => {
    it("returns ask for find -delete in build mode", () => {
      assert.equal(checkBashPermission("find . -delete", "build", BASELINE).action, "ask");
    });

    it("returns ask for find -exec rm in build mode", () => {
      assert.equal(checkBashPermission('find . -name "*.ts" -exec rm {} \\;', "build", BASELINE).action, "ask");
    });

    it("returns ask for find -execdir even with read-only subcmd", () => {
      assert.equal(checkBashPermission('find . -execdir ls {} \\;', "build", BASELINE).action, "ask");
    });

    it("returns ask for find -delete in plan mode", () => {
      assert.equal(checkBashPermission("find . -delete", "plan", BASELINE).action, "ask");
    });
  });

  describe("redirect targets go through file permissions", () => {
    it("denies redirect to hazardous file", () => {
      assert.equal(checkBashPermission("echo hi >> .env", "build", BASELINE).action, "deny");
    });

    it("returns ask for redirect to external path", () => {
      assert.equal(checkBashPermission("ls > /etc/passwd", "build", BASELINE, "/project").action, "ask");
    });

    it("returns ask for redirect to internal file (edit catch-all)", () => {
      assert.equal(checkBashPermission("ls > out.txt", "build", BASELINE).action, "ask");
    });

    it("denies redirect to .env with double-quoted path", () => {
      assert.equal(checkBashPermission('echo hi >> ".env"', "build", BASELINE).action, "deny");
    });

    it("returns ask for redirect to external path with double quotes", () => {
      assert.equal(checkBashPermission('echo hi > "/etc/passwd"', "build", BASELINE, "/project").action, "ask");
    });

    it("denies input redirect from hazardous file", () => {
      assert.equal(checkBashPermission("sort < .env", "build", BASELINE).action, "deny");
    });

    it("returns ask for input redirect from external path", () => {
      assert.equal(checkBashPermission("sort < /etc/passwd", "build", BASELINE, "/project").action, "ask");
    });
  });

  describe("unapproved tracking", () => {
    it("lists only unapproved subcommands", () => {
      assert.deepEqual(checkBashPermission("gcc", "build", BASELINE).unapproved, ["gcc"]);
    });

    it("empty unapproved when all allowed", () => {
      assert.deepEqual(checkBashPermission("ls -la", "build", BASELINE).unapproved, []);
    });

    it("mixed pipeline: allowed + unapproved", () => {
      const result = checkBashPermission("ls | python3", "build", BASELINE);
      assert.equal(result.action, "ask");
      assert.ok(result.unapproved?.some((u) => u.startsWith("python3")));
    });

    it("[ -f path ] triggers read permission check on the path", () => {
      const result = checkBashPermission("[ -f /etc/passwd ]", "build", BASELINE, "/project");
      assert.ok(result.redirectTargets?.some((rt) => rt.path === "/etc/passwd" && rt.permission === "read"));
    });

    it("[[ -f path ]] triggers read permission check on the path", () => {
      const result = checkBashPermission("[[ -f /etc/passwd ]]", "build", BASELINE, "/project");
      assert.ok(result.redirectTargets?.some((rt) => rt.path === "/etc/passwd" && rt.permission === "read"));
    });
  });

  describe("recheck uses fresh rules (stale closure bug regression)", () => {
    it("stale rules snapshot does not reflect newly added allow rule", () => {
      const command = "npm install";
      const staleRules = BASELINE;
      const staleRecheck = () => checkBashPermission(command, "build", staleRules);

      assert.equal(staleRecheck().action, "ask");

      const updatedRules = [...BASELINE, { permission: "bash" as const, pattern: "npm install *", action: "allow" as const, modes: ALL_MODES }];
      const freshRecheck = () => checkBashPermission(command, "build", updatedRules);

      assert.equal(staleRecheck().action, "ask");
      assert.equal(freshRecheck().action, "allow");
    });

    it("stale file rules snapshot does not reflect newly added allow rule", () => {
      const filePath = "src/new-feature.ts";
      const staleRules = BASELINE;
      const freshRules = [...BASELINE, { permission: "edit" as const, pattern: "src/new-feature.ts", action: "allow" as const, modes: ALL_MODES }];

      assert.equal(checkFileTarget(filePath, "edit", "build", staleRules).action, "ask");
      assert.equal(checkFileTarget(filePath, "edit", "build", freshRules).action, "allow");
    });
  });

  describe("file path normalization mismatch", () => {
    it("absolute path pattern does not match relative target via picomatch", () => {
      assert.equal(checkFileTarget("/home/user/project/src/foo.ts", "edit", "build", [
        { permission: "edit", pattern: "/home/user/project/src/foo.ts", action: "allow", modes: ALL_MODES },
        { permission: "edit", pattern: "**", action: "ask", modes: ALL_MODES },
      ], "/home/user/project").action, "ask");
    });

    it("relative path pattern matches relative target via picomatch", () => {
      const rules: Ruleset = [
        { permission: "edit", pattern: "**", action: "ask", modes: ALL_MODES },
        { permission: "edit", pattern: "src/foo.ts", action: "allow", modes: ALL_MODES },
      ];
      assert.equal(checkFileTarget("src/foo.ts", "edit", "build", rules).action, "allow");
    });
  });

  describe("redirect targets tracking", () => {
    it("populates redirectTargets for output redirect needing approval", () => {
      const result = checkBashPermission("ls > out.txt", "build", BASELINE);
      assert.equal(result.action, "ask");
      assert.ok(result.redirectTargets?.some((rt) => rt.permission === "edit" && rt.path === "out.txt"));
    });

    it("populates redirectTargets for input redirect needing approval", () => {
      const result = checkBashPermission("cat < /tmp/external.txt", "build", BASELINE, "/project");
      assert.equal(result.action, "ask");
      assert.ok(result.redirectTargets?.some((rt) => rt.permission === "read"));
    });

    it("no redirectTargets when all redirects are allowed", () => {
      const result = checkBashPermission("cat file.txt", "build", BASELINE);
      assert.equal(result.action, "allow");
      assert.equal(result.redirectTargets?.length ?? 0, 0);
    });

    it("bash allow rule + edit allow rule for redirect allows the full command", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES },
        { permission: "edit", pattern: "out.txt", action: "allow", modes: ALL_MODES },
      ];
      assert.equal(checkBashPermission("ls > out.txt", "build", rules).action, "allow");
    });

    it("redirect to /dev/null does not require approval", () => {
      const result = checkBashPermission("ls > /dev/null", "build", BASELINE);
      assert.equal(result.action, "allow");
      assert.equal(result.redirectTargets?.length ?? 0, 0);
    });

    it("redirect from /dev/null does not require approval", () => {
      const result = checkBashPermission("cat < /dev/null", "build", BASELINE);
      assert.equal(result.action, "allow");
      assert.equal(result.redirectTargets?.length ?? 0, 0);
    });

    it("redirect to /dev/zero does not require approval", () => {
      const result = checkBashPermission("dd if=/dev/zero of=/dev/null bs=1 count=0", "build", BASELINE);
      // dd is ask by default; /dev/null and /dev/zero redirects should not add extra ask
      assert.ok(!result.redirectTargets?.some((rt) => rt.path === "/dev/null" || rt.path === "/dev/zero"));
    });

    it("redirect approval with edited path creates edit rule from edited text", () => {
      // Simulates the approval flow: user edits redirect path "data/out.json" → "data/*"
      // The resulting rule should be an edit rule (not bash), using the edited pattern.
      const editedPath = "data/*";
      // Simulate what resolvePermission does for redirect patterns:
      const pattern = toRecursiveGlob(normalizePathForMatching(editedPath, "/project"));
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ALL_MODES },
      ];
      // Should match any file under data/ (not just data/out.json)
      assert.equal(checkFileTarget("data/out.json", "edit", "build", rules, "/project").action, "allow");
      assert.equal(checkFileTarget("data/other.json", "edit", "build", rules, "/project").action, "allow");
    });

    it("redirect approval does not create bash rules for redirect paths", () => {
      // Bug: previously, approving a redirect alongside a bash subcommand
      // created a bash rule for the redirect path (e.g. bash: data/* -> allow),
      // which is useless. Only edit/read rules should be created.
      //
      // Verify: a bash rule matching a file path should NOT allow the command.
      // Only an edit rule for the redirect path should work.
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "ls *", action: "allow", modes: ALL_MODES },
        // WRONG (old bug): bash rule for file path — should not help
        { permission: "bash", pattern: "data/*", action: "allow", modes: ALL_MODES },
      ];
      // The redirect target (data/out.json) is checked as edit permission, not bash.
      // A bash rule for data/* should not auto-approve the redirect.
      const result = checkBashPermission("ls > data/out.json", "build", rules);
      assert.equal(result.action, "ask");
      assert.ok(result.redirectTargets?.some((rt) => rt.permission === "edit" && rt.path === "data/out.json"));
    });

    it("edited redirect path with glob matches subsequent different files", () => {
      // End-to-end simulation: after user approves "data/*" as edit pattern,
      // a later command with a different output file should auto-approve.
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "stockbot *", action: "allow", modes: ALL_MODES },
        { permission: "edit", pattern: "data/*", action: "allow", modes: ALL_MODES },
      ];
      // Different file from the one originally approved — should still pass
      assert.equal(
        checkBashPermission("stockbot bars NVDA --json > data/nvda_1min_202508.json", "build", rules).action,
        "allow",
      );
    });

    it("checkFileTarget allows /dev/null directly", () => {
      assert.equal(checkFileTarget("/dev/null", "edit", "build", BASELINE).action, "allow");
      assert.equal(checkFileTarget("/dev/null", "read", "build", BASELINE).action, "allow");
    });

    it("checkFileTarget allows /dev/urandom directly", () => {
      assert.equal(checkFileTarget("/dev/urandom", "read", "build", BASELINE).action, "allow");
    });

    it("checkFileTarget still asks for non-safe /dev paths", () => {
      assert.equal(checkFileTarget("/dev/sda1", "edit", "build", BASELINE).action, "ask");
    });
  });

  describe("external path approvals", () => {
    it("baseline read: ** rule does not auto-approve external paths", () => {
      // Without the fix, baseline read: ** -> allow would auto-approve /etc/passwd
      assert.equal(checkFileTarget("/etc/passwd", "read", "build", BASELINE).action, "ask");
    });

    it("user allow rule overrides external path default", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern: "/tmp/config.yaml", action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("/tmp/config.yaml", "edit", "build", rules).action, "allow");
    });

    it("user read allow rule overrides external path default", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "read", pattern: "/etc/hosts", action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("/etc/hosts", "read", "build", rules).action, "allow");
    });

    it("specific user deny rule still denies external paths", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern: "/tmp/secret", action: "deny", modes: ALL_MODES },
      ];
      assert.equal(checkFileTarget("/tmp/secret", "edit", "build", rules).action, "deny");
    });
  });

  describe("rootless glob approval patterns", () => {
    it("**/*.ts pattern matches files at any depth", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern: "**/*.ts", action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("test.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/test.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/deep/test.ts", "edit", "build", rules).action, "allow");
    });

    it("bare ** pattern matches everything", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern: "**", action: "allow", modes: ALL_MODES },
      ];
      assert.equal(checkFileTarget("anything.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/anything.ts", "edit", "build", rules).action, "allow");
    });
  });

  describe("glob approval via normalizePathForMatching + toRecursiveGlob", () => {
    it("src/subdir/**/*.ts pattern matches nested file", () => {
      // Simulates user editing path to glob in approval prompt
      const pattern = toRecursiveGlob(normalizePathForMatching("src/awesome-script/**/*.ts", "/project"));
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("src/awesome-script/utils/playerStore.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/awesome-script/playerStore.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/other/file.ts", "edit", "build", rules).action, "ask");
    });

    it("absolute path input is normalized as rule pattern", () => {
      // Non-edited file item: item.text = absolute path from tool call
      const pattern = toRecursiveGlob(normalizePathForMatching("/project/src/foo.ts", "/project"));
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("src/foo.ts", "edit", "build", rules).action, "allow");
    });

    it("rootless glob in user edit becomes recursive", () => {
      const pattern = toRecursiveGlob(normalizePathForMatching("*.ts", "/project"));
      assert.equal(pattern, "**/*.ts");
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget("test.ts", "edit", "build", rules).action, "allow");
      assert.equal(checkFileTarget("src/deep/test.ts", "edit", "build", rules).action, "allow");
    });

    it("tilde-prefixed glob matches external home path", () => {
      const home = process.env.HOME ?? "/home/user";
      const cwd = "/project";
      // User types ~/.bun/**/*.ts in approval prompt
      const pattern = toRecursiveGlob(normalizePathForMatching("~/.bun/**/*.ts", cwd));
      // Should expand ~ to absolute: /home/user/.bun/**/*.ts
      assert.equal(pattern, home + "/.bun/**/*.ts");
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ["build"] },
      ];
      // checkFileTarget normalizes absolute external path to absolute form
      const target = home + "/.bun/install/global/node_modules/@scope/pkg/dist/types.d.ts";
      assert.equal(checkFileTarget(target, "edit", "build", rules, cwd).action, "allow");
    });

    it("tilde-prefixed specific path matches", () => {
      const home = process.env.HOME ?? "/home/user";
      const cwd = "/project";
      const pattern = toRecursiveGlob(normalizePathForMatching("~/config/app.yaml", cwd));
      assert.equal(pattern, home + "/config/app.yaml");
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "edit", pattern, action: "allow", modes: ["build"] },
      ];
      assert.equal(checkFileTarget(home + "/config/app.yaml", "edit", "build", rules, cwd).action, "allow");
    });
  });
});
