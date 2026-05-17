import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermission, checkFileTarget } from "./check.ts";
import { parseCommand } from "./bash-parser.ts";
import { getBaselineRules } from "./permissions/index.ts";

const RULES = getBaselineRules();
const CWD = "/home/user/project";

describe("checkBashPermission cd auto-approve", () => {
  it("auto-approves cd to cwd", () => {
    const result = checkBashPermission(
      `cd ${CWD} && git diff`,
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves cd to subdirectory within cwd", () => {
    const result = checkBashPermission(
      `cd ${CWD}/src && ls`,
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves bare cd (no argument)", () => {
    const result = checkBashPermission(
      "cd && git status",
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves relative cd within project", () => {
    const result = checkBashPermission(
      "cd src && ls",
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves cd with ~ expansion to cwd", () => {
    // Set HOME so ~ resolves to something within cwd
    const origHome = process.env.HOME;
    process.env.HOME = CWD;
    try {
      const result = checkBashPermission(
        "cd ~/src && ls",
        "plan",
        RULES,
        CWD,
      );
      assert.equal(result.action, "allow");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("still requires approval for cd outside cwd", () => {
    const result = checkBashPermission(
      "cd /tmp && ls",
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "ask");
    assert.ok(result.unapproved!.some((c) => c.startsWith("cd /tmp")));
  });

  it("still requires approval for cd to parent of cwd", () => {
    const result = checkBashPermission(
      "cd /home/user && ls",
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "ask");
  });

  it("auto-approves quoted cd path within cwd", () => {
    const result = checkBashPermission(
      `cd "${CWD}/src" && ls`,
      "plan",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
  });
});

describe("checkBashPermission plan-mode edit denial", () => {
  // In plan mode, bash commands that are functionally equivalent to
  // the edit/write tools (which are disabled) should be denied outright,
  // not merely prompted with 'ask'.

  const DENY_IN_PLAN: [string, string][] = [
    // Heredoc + redirect (was escaping before parser gap fix)
    ["cat <<EOF > file.txt\nhello\nEOF", "heredoc with > redirect"],
    ["cat <<EOF >> file.txt\nhello\nEOF", "heredoc with >> redirect"],
    ["cat <<EOF | tee file.txt\nhello\nEOF", "heredoc piped to tee"],

    // Output redirects
    ["echo hello > file.txt", "echo redirect"],
    ["cat file.txt > new.txt", "cat redirect"],
    ["grep pat file.txt > out.txt", "grep redirect"],

    // In-place edit flags
    ["sed -i s/foo/bar/ file.txt", "sed -i"],
    ["perl -pi -e s/foo/bar/ file.txt", "perl -pi"],

    // Write-purpose commands
    ["tee file.txt", "tee"],
    ["truncate -s 0 file.txt", "truncate"],
    ["install -m 644 src dst", "install"],

    // Interpreter one-liners
    ["python3 -c \"open('f','w')\"", "python3 -c"],
    ["node -e \"require('fs').writeFileSync('f','hi')\"", "node -e"],
    ["sh -c 'echo hi > f.txt'", "sh -c"],
  ];

  for (const [cmd, label] of DENY_IN_PLAN) {
    it(`denies in plan mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "plan", RULES, CWD);
      assert.equal(result.action, "deny");
      assert.ok(result.reason?.includes("Plan mode"));
    });

    it(`does not deny in build mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "build", RULES, CWD);
      assert.notEqual(result.action, "deny");
    });
  }

  // Read-only commands must still be allowed in plan mode
  const ALLOW_IN_PLAN: [string, string][] = [
    ["cat file.txt", "cat"],
    ["ls -la", "ls"],
    ["grep pattern file.txt", "grep"],
    ["find . -name '*.ts'", "find"],
    ["git status", "git status"],
    ["echo hello", "echo (no redirect)"],
    ["sed -n 5p file.txt", "sed -n (read-only)"],
    ["jq . file.json", "jq"],
  ];

  for (const [cmd, label] of ALLOW_IN_PLAN) {
    it(`allows in plan mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "plan", RULES, CWD);
      assert.equal(result.action, "allow");
    });
  }
});

describe("read-only tools (grep/find/ls) use read permission, not bash parsing", () => {
  // These tools are handled via checkFileTarget(permission="read") instead
  // of checkBashPermission. The pattern should never be bash-parsed.
  //
  // This test verifies that a grep pattern containing shell metacharacters
  // (like |) is NOT treated as a pipe by the permission system.
  // Before the fix, `grep registerTool|renderShell` was bash-parsed
  // into two subcommands: "grep registerTool" and "renderShell",
  // causing a spurious approval prompt for the phantom "renderShell" command.

  it("bash parser splits grep with pipe in pattern (confirming the old bug)", () => {
    const parsed = parseCommand("grep registerTool|renderShell");
    assert.ok(parsed.subcommands.includes("renderShell"),
      `Expected "renderShell" in subcommands, got: ${parsed.subcommands}`);
  });

  it("checkFileTarget treats path as a read target, not a bash command", () => {
    // The directory /tmp is outside the project root, so it should
    // be "ask" (not "deny" and not bash-parsed)
    const result = checkFileTarget("/tmp/some/dir", "read", "build", RULES, CWD);
    assert.equal(result.action, "ask");
    assert.ok(!result.reason?.includes("renderShell"));
  });

  it("checkFileTarget allows reads within project root", () => {
    const result = checkFileTarget(`${CWD}/src/index.ts`, "read", "build", RULES, CWD);
    assert.equal(result.action, "allow");
  });

  it("checkFileTarget denies hazardous files", () => {
    const result = checkFileTarget(`${CWD}/.env`, "read", "build", RULES, CWD);
    assert.equal(result.action, "deny");
  });

  it("checkFileTarget auto-approves reading the project root itself (ls .)", () => {
    // normalizePathForMatching turns "." into ".", which matches "**" via
    // the special case in matchesPattern.
    const result = checkFileTarget(".", "read", "build", RULES, "/home/user/project");
    assert.equal(result.action, "allow");
  });

  it("checkFileTarget auto-approves reading the project root via ~-prefixed path", () => {
    // normalizePathForMatching expands ~ and strips the project root prefix,
    // producing "." which matches "**" via the special case in matchesPattern.
    const home = process.env.HOME ?? "/home/user";
    const result = checkFileTarget("~/project", "read", "build", RULES, home + "/project");
    assert.equal(result.action, "allow");
  });

  it("checkFileTarget auto-approves reading the project root via absolute path", () => {
    const result = checkFileTarget(CWD, "read", "build", RULES, CWD);
    assert.equal(result.action, "allow");
  });
});
