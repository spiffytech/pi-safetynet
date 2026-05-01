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
