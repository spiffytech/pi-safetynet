import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermission } from "./check.ts";
import { getBaselineRules } from "./permissions/index.ts";

const RULES = getBaselineRules();
const PROJECT_ROOT = "/home/user/project";

describe("checkBashPermission cd auto-approve", () => {
  it("auto-approves cd to project root", () => {
    const result = checkBashPermission(
      `cd ${PROJECT_ROOT} && git diff`,
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves cd to subdirectory within project", () => {
    const result = checkBashPermission(
      `cd ${PROJECT_ROOT}/src && ls`,
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves bare cd (no argument)", () => {
    const result = checkBashPermission(
      "cd && git status",
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves relative cd within project", () => {
    const result = checkBashPermission(
      "cd src && ls",
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves cd with ~ expansion to project", () => {
    // Set HOME so ~ resolves to something within project root
    const origHome = process.env.HOME;
    process.env.HOME = PROJECT_ROOT;
    try {
      const result = checkBashPermission(
        "cd ~/src && ls",
        "plan",
        RULES,
        PROJECT_ROOT,
      );
      assert.equal(result.action, "allow");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("still requires approval for cd outside project root", () => {
    const result = checkBashPermission(
      "cd /tmp && ls",
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "ask");
    assert.ok(result.unapproved!.some((c) => c.startsWith("cd /tmp")));
  });

  it("still requires approval for cd to parent of project root", () => {
    const result = checkBashPermission(
      "cd /home/user && ls",
      "plan",
      RULES,
      PROJECT_ROOT,
    );
    assert.equal(result.action, "ask");
  });

  it("auto-approves quoted cd path within project", () => {
    const result = checkBashPermission(
      `cd "${PROJECT_ROOT}/src" && ls`,
      "plan",
      RULES,
      PROJECT_ROOT,
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
      const result = checkBashPermission(cmd, "plan", RULES, PROJECT_ROOT);
      assert.equal(result.action, "deny");
      assert.ok(result.reason?.includes("Plan mode"));
    });

    it(`does not deny in build mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "build", RULES, PROJECT_ROOT);
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
      const result = checkBashPermission(cmd, "plan", RULES, PROJECT_ROOT);
      assert.equal(result.action, "allow");
    });
  }
});
