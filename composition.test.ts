import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getAllCommands,
  hasFileRedirects,
  isCatastrophicCommand,
  isHazardousFile,
  getRedirectTargets,
} from "./bash-parser.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { isExternalPath, normalizePathForMatching } from "./project.ts";
import type { Ruleset, PermissionAction, ProfileName } from "./types.ts";
import baselineData from "./permissions/baseline.json" with { type: "json" };

const BASELINE: Ruleset = baselineData.rules as Ruleset;
const ALL_MODES: ProfileName[] = ["build", "plan"];

function checkFileTarget(
  filePath: string,
  permission: "read" | "edit",
  profile: ProfileName,
  rules: Ruleset,
  projectRoot: string,
): PermissionAction {
  if (isHazardousFile(filePath)) return "deny";
  if (isExternalPath(filePath, projectRoot)) return "ask";
  const normalized = normalizePathForMatching(filePath, projectRoot);
  return evaluatePermission(permission, normalized, profile, rules).action;
}

function composeBashPermission(
  command: string,
  profile: ProfileName,
  rules: Ruleset = BASELINE,
  projectRoot: string = "/project",
): { action: PermissionAction; unapproved: string[] } {
  if (isCatastrophicCommand(command)) {
    return { action: "deny", unapproved: [] };
  }

  const subcommands = getAllCommands(command);

  const unapproved: string[] = [];
  let worstAction: PermissionAction = "allow";

  for (const sub of subcommands) {
    const result = evaluatePermission("bash", sub, profile, rules);
    if (result.action === "deny") {
      worstAction = "deny";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    } else if (result.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      if (!unapproved.includes(sub)) unapproved.push(sub);
    }
  }

  if (hasFileRedirects(command)) {
    const targets = getRedirectTargets(command);
    for (const target of targets) {
      const permission = target.direction === "input" ? "read" : "edit";
      const targetAction = checkFileTarget(target.path, permission, profile, rules, projectRoot);
      if (targetAction === "deny") {
        worstAction = "deny";
      } else if (targetAction === "ask" && worstAction === "allow") {
        worstAction = "ask";
      }
    }
  }

  return { action: worstAction, unapproved };
}

describe("composeBashPermission", () => {
  describe("currently-working commands", () => {
    it("returns ask for hostname in build mode", () => {
      const result = composeBashPermission("hostname", "build");
      assert.equal(result.action, "ask");
    });

    it("allows ls -la in build mode", () => {
      const result = composeBashPermission("ls -la", "build");
      assert.equal(result.action, "allow");
    });

    it("allows cat file.txt in build mode", () => {
      const result = composeBashPermission("cat file.txt", "build");
      assert.equal(result.action, "allow");
    });

    it("allows echo hi in build mode", () => {
      const result = composeBashPermission("echo hi", "build");
      assert.equal(result.action, "allow");
    });

    it("allows pwd in build mode", () => {
      const result = composeBashPermission("pwd", "build");
      assert.equal(result.action, "allow");
    });

    it("allows whoami in build mode", () => {
      const result = composeBashPermission("whoami", "build");
      assert.equal(result.action, "allow");
    });

    it("allows date in build mode", () => {
      const result = composeBashPermission("date", "build");
      assert.equal(result.action, "allow");
    });

    it("allows piped commands when both are allowlisted", () => {
      const result = composeBashPermission("ls | grep foo", "build");
      assert.equal(result.action, "allow");
    });

    it("allows find without -exec in build mode", () => {
      const result = composeBashPermission("find . -name '*.ts'", "build");
      assert.equal(result.action, "allow");
    });

    it("returns ask for unknown commands in build mode", () => {
      const result = composeBashPermission("python3", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for npm install in build mode", () => {
      const result = composeBashPermission("npm install", "build");
      assert.equal(result.action, "ask");
    });

    it("denies catastrophic commands regardless of profile", () => {
      assert.equal(composeBashPermission("rm -rf /", "build").action, "deny");
      assert.equal(composeBashPermission("rm -rf /", "plan").action, "deny");
    });
  });

  describe("A2 fix: subcommand rules now match full command strings", () => {
    it("allows git status in build mode", () => {
      const result = composeBashPermission("git status", "build");
      assert.equal(result.action, "allow");
    });

    it("allows git log --oneline in build mode", () => {
      const result = composeBashPermission("git log --oneline", "build");
      assert.equal(result.action, "allow");
    });

    it("allows git diff HEAD in build mode", () => {
      const result = composeBashPermission("git diff HEAD", "build");
      assert.equal(result.action, "allow");
    });

    it("allows git branch -a in build mode", () => {
      const result = composeBashPermission("git branch -a", "build");
      assert.equal(result.action, "allow");
    });

    it("allows git remote -v in build mode", () => {
      const result = composeBashPermission("git remote -v", "build");
      assert.equal(result.action, "allow");
    });

    it("allows git config --get user.name in build mode", () => {
      const result = composeBashPermission("git config --get user.name", "build");
      assert.equal(result.action, "allow");
    });

    it("allows npm list in build mode", () => {
      const result = composeBashPermission("npm list", "build");
      assert.equal(result.action, "allow");
    });

    it("allows npm view react in build mode", () => {
      const result = composeBashPermission("npm view react", "build");
      assert.equal(result.action, "allow");
    });

    it("allows sed -n 1p file in build mode", () => {
      const result = composeBashPermission("sed -n 1p file", "build");
      assert.equal(result.action, "allow");
    });

    it("allows yarn list in build mode", () => {
      const result = composeBashPermission("yarn list", "build");
      assert.equal(result.action, "allow");
    });

    it("allows yarn info react in build mode", () => {
      const result = composeBashPermission("yarn info react", "build");
      assert.equal(result.action, "allow");
    });
  });

  describe("arbitrary code execution commands require approval", () => {
    it("returns ask for node -e in build mode", () => {
      const result = composeBashPermission("node -e 'console.log(1)'", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for bun -e in build mode", () => {
      const result = composeBashPermission("bun -e 'console.log(1)'", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for curl in build mode", () => {
      const result = composeBashPermission("curl https://example.com", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for wget in build mode", () => {
      const result = composeBashPermission("wget https://example.com/file.tar.gz", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for xargs in build mode", () => {
      const result = composeBashPermission("find . -name '*.ts' | xargs rm", "build");
      assert.equal(result.action, "ask");
    });
  });

  describe("find -exec/-delete require approval (E3/E4)", () => {
    it("returns ask for find -delete in build mode", () => {
      const result = composeBashPermission("find . -delete", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for find -exec rm in build mode", () => {
      const result = composeBashPermission('find . -name "*.ts" -exec rm {} \\;', "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for find -execdir in build mode even with read-only subcmd", () => {
      const result = composeBashPermission('find . -execdir ls {} \\;', "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for find -delete in plan mode", () => {
      const result = composeBashPermission("find . -delete", "plan");
      assert.equal(result.action, "ask");
    });
  });

  describe("redirect targets go through file permissions (E2)", () => {
    it("denies redirect to hazardous file", () => {
      const result = composeBashPermission("echo hi >> .env", "build");
      assert.equal(result.action, "deny");
    });

    it("returns ask for redirect to external path", () => {
      const result = composeBashPermission("ls > /etc/passwd", "build", BASELINE, "/project");
      assert.equal(result.action, "ask");
    });

    it("returns ask for redirect to internal file (edit catch-all)", () => {
      const result = composeBashPermission("ls > out.txt", "build");
      assert.equal(result.action, "ask");
    });

    it("denies redirect to .env with double-quoted path", () => {
      const result = composeBashPermission('echo hi >> ".env"', "build");
      assert.equal(result.action, "deny");
    });

    it("returns ask for redirect to external path with double quotes", () => {
      const result = composeBashPermission('echo hi > "/etc/passwd"', "build", BASELINE, "/project");
      assert.equal(result.action, "ask");
    });

    it("denies input redirect from hazardous file", () => {
      const result = composeBashPermission("sort < .env", "build");
      assert.equal(result.action, "deny");
    });

    it("returns ask for input redirect from external path", () => {
      const result = composeBashPermission("sort < /etc/passwd", "build", BASELINE, "/project");
      assert.equal(result.action, "ask");
    });
  });

  describe("file-writing commands require approval", () => {
    it("returns ask for tee in build mode", () => {
      const result = composeBashPermission("tee out.txt", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for cp in build mode", () => {
      const result = composeBashPermission("cp src dst", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for mv in build mode", () => {
      const result = composeBashPermission("mv old new", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for tee in plan mode", () => {
      const result = composeBashPermission("tee out.txt", "plan");
      assert.equal(result.action, "ask");
    });
  });

  describe("sudo handling", () => {
    it("returns ask for sudo rm file.txt in build mode", () => {
      const result = composeBashPermission("sudo rm file.txt", "build");
      assert.equal(result.action, "ask");
    });

    it("returns ask for sudo ls in build mode (sudo is never allowlisted)", () => {
      const result = composeBashPermission("sudo ls", "build");
      assert.equal(result.action, "ask");
    });

    it("denies sudo rm -rf / regardless of profile", () => {
      assert.equal(composeBashPermission("sudo rm -rf /", "build").action, "deny");
      assert.equal(composeBashPermission("sudo rm -rf /", "plan").action, "deny");
    });

    it("denies sudo chown on protected dir", () => {
      assert.equal(composeBashPermission("sudo chown root /etc", "build").action, "deny");
    });

    it("denies sudo chmod on protected dir", () => {
      assert.equal(composeBashPermission("sudo chmod 777 /usr", "build").action, "deny");
    });

    it("denies sudo with flags before command (sudo -u root rm /etc)", () => {
      assert.equal(composeBashPermission("sudo -u root rm /etc", "build").action, "deny");
    });

    it("denies sudo -E chown on protected dir", () => {
      assert.equal(composeBashPermission("sudo -E chown root /usr", "build").action, "deny");
    });
  });

  describe("catastrophic command composition", () => {
    it("denies rm -rf /tmp in build mode", () => {
      const result = composeBashPermission("rm -rf /tmp", "build");
      assert.equal(result.action, "deny");
    });

    it("denies chown on protected dir", () => {
      assert.equal(composeBashPermission("chown root /etc", "build").action, "deny");
    });

    it("denies rm with double-quoted protected dir", () => {
      assert.equal(composeBashPermission('rm "/etc"', "build").action, "deny");
      assert.equal(composeBashPermission('rm "/usr"', "plan").action, "deny");
    });
  });

  describe("plan mode: ask-by-default", () => {
    it("allows ls in plan mode (baseline allow with modes: build+plan)", () => {
      const result = composeBashPermission("ls", "plan");
      assert.equal(result.action, "allow");
    });

    it("allows git status in plan mode", () => {
      const result = composeBashPermission("git status", "plan");
      assert.equal(result.action, "allow");
    });

    it("allows cat in plan mode", () => {
      const result = composeBashPermission("cat file.txt", "plan");
      assert.equal(result.action, "allow");
    });

    it("returns ask for hostname in plan mode (ask-by-default)", () => {
      const result = composeBashPermission("hostname", "plan");
      assert.equal(result.action, "ask");
    });

    it("returns ask for npm install in plan mode", () => {
      const result = composeBashPermission("npm install", "plan");
      assert.equal(result.action, "ask");
    });
  });

  describe("unapproved list", () => {
    it("lists only unapproved subcommands", () => {
      const result = composeBashPermission("hostname", "build");
      assert.deepEqual(result.unapproved, ["hostname"]);
    });

    it("empty unapproved when all allowed", () => {
      const result = composeBashPermission("ls -la", "build");
      assert.deepEqual(result.unapproved, []);
    });

    it("mixed pipeline: allowed + unapproved", () => {
      const result = composeBashPermission("ls | python3", "build");
      assert.equal(result.action, "ask");
      assert.ok(result.unapproved.some((u) => u.startsWith("python3")));
    });
  });

  describe("multi-rule session + persisted", () => {
    it("session rule overrides baseline in build mode", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build"] },
      ];
      const result = composeBashPermission("hostname", "build", rules);
      assert.equal(result.action, "allow");
    });

    it("build-only session rule is invisible to plan mode", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build"] },
      ];
      const result = composeBashPermission("hostname", "plan", rules);
      assert.equal(result.action, "ask");
    });

    it("plan+build session rule applies in both profiles", () => {
      const rules: Ruleset = [
        ...BASELINE,
        { permission: "bash", pattern: "hostname", action: "allow", modes: ["build", "plan"] },
      ];
      assert.equal(composeBashPermission("hostname", "build", rules).action, "allow");
      assert.equal(composeBashPermission("hostname", "plan", rules).action, "allow");
    });
  });
});
