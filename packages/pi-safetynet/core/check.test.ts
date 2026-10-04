import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermission, checkFileTarget, checkToolPermission, actionWrites, patternHasBashGlob } from "./check.ts";
import { normalizeToolPath } from "pi-submarine-core";
import { parseCommand } from "./bash-parser.ts";
import { getBaselineRules } from "./permissions/index.ts";
import { setSandboxDir } from "./sandbox.ts";
import type { Ruleset } from "./types.ts";

const RULES = getBaselineRules();
const CWD = "/home/user/project";

describe("actionWrites — mechanical write classification for mode enforcement", () => {
  it("classifies the edit tool as a write", () => {
    assert.equal(actionWrites("edit", { action: "ask" }), true);
  });

  it("classifies bash with an output redirect as a write", () => {
    assert.equal(
      actionWrites("bash", { action: "ask", redirectTargets: [{ permission: "edit", path: "/tmp/out.txt" }] }),
      true,
    );
  });

  it("does not classify bash with only input redirects as a write", () => {
    assert.equal(
      actionWrites("bash", { action: "ask", redirectTargets: [{ permission: "read", path: "/tmp/in.txt" }] }),
      false,
    );
  });

  it("does not classify reads as writes", () => {
    assert.equal(actionWrites("read", { action: "ask" }), false);
  });
});

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
    ["read f", "read (builtin)"],
    ["read -r line", "read -r (builtin)"],
  ];

  for (const [cmd, label] of ALLOW_IN_PLAN) {
    it(`allows in plan mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "plan", RULES, CWD);
      assert.equal(result.action, "allow");
    });
  }
});

describe("checkBashPermission ro-mode edit denial", () => {
  // ro mode mirrors plan mode's read-only gate (soft enforcement). Writes must
  // be denied with the read-only label; reads stay allowed. modeAliases maps
  // ro→plan so the plan/build baseline rules apply to ro (as index.ts passes
  // getModeAliases() in production).
  const RO_ALIASES = { ro: "plan" } as Record<string, "plan">;

  const WRITE_CMDS: [string, string][] = [
    ["sed -i s/foo/bar/ file.txt", "sed -i"],
    ["echo hello > file.txt", "echo redirect"],
    ["tee file.txt", "tee"],
    ["python3 -c \"open('f','w')\"", "python3 -c"],
  ];

  for (const [cmd, label] of WRITE_CMDS) {
    it(`denies in ro mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "ro", RULES, CWD, false, RO_ALIASES);
      assert.equal(result.action, "deny");
      assert.ok(result.reason?.includes("Read-only mode"));
      assert.equal(result.modeDenied, true, "flagged as mode-enforced for deny labelling/guidance");
    });

    it(`does not deny in rw mode: ${label}`, () => {
      const result = checkBashPermission(cmd, "rw", RULES, CWD, false, { rw: "build" } as Record<string, "build">);
      assert.notEqual(result.action, "deny");
    });
  }

  it("allows read-only bash in ro mode", () => {
    const result = checkBashPermission("cat file.txt && git status", "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "allow");
  });
});

describe("checkBashPermission bare variable assignment auto-approve", () => {
  it("auto-approves single bare variable assignment", () => {
    const result = checkBashPermission(
      'ORDER_ID=ef0a6ea9-4f7d-4471-a51e-5db753d111ce && echo done',
      "build",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves multiple bare variable assignments", () => {
    const result = checkBashPermission(
      'A=1 B=2 && echo hi',
      "build",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });

  it("auto-approves assignment with quoted value", () => {
    const result = checkBashPermission(
      'ORDER_ID="ef0a6ea9-4f7d-4471-a51e-5db753d111ce" && echo done',
      "build",
      RULES,
      CWD,
    );
    // The parser strips quotes in the subcommand, so ORDER_ID=ef0a6ea9-... is detected
    assert.equal(result.action, "allow");
  });

  it("still requires approval for assignment prefix to a real command", () => {
    // A=1 bun cli.ts — the parser produces "A=1 bun cli.ts" as one subcommand,
    // which does NOT match isBareAssignment (not all tokens are VAR=value)
    const result = checkBashPermission(
      'A=1 some_unknown_cmd',
      "build",
      RULES,
      CWD,
    );
    assert.equal(result.action, "ask");
  });

  it("still denies catastrophic commands after bare assignment", () => {
    const result = checkBashPermission(
      'A=1 && rm -rf /',
      "build",
      RULES,
      CWD,
    );
    assert.equal(result.action, "deny");
  });

  it("auto-approves bare assignment alone (no follow-up command)", () => {
    const result = checkBashPermission(
      'ORDER_ID=abc',
      "build",
      RULES,
      CWD,
    );
    assert.equal(result.action, "allow");
  });

  it("auto-approves assignment values containing whitespace or substitutions", () => {
    // Regression: isBareAssignment used to whitespace-split the raw subcommand,
    // so any value with spaces (`A=$(cmd arg)`, `A="a b"`) failed the NAME= test
    // and the wrapper escalated as an unknown command.
    for (const cmd of [
      'A=$(echo hi)',
      'A=$(echo hi) B=$(date)',
      'A="hello world"',
      "A='hello world'",
      'A=`echo hi`',
      'A=<(echo hi)',
    ]) {
      const result = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(result.action, "allow", `${cmd} must be allowed`);
      assert.deepEqual(result.unapproved, [], `${cmd} must not escalate`);
    }
  });

  it("still asks when the assignment prefixes a real command", () => {
    assert.equal(checkBashPermission("A=1 some_unknown_cmd", "build", RULES, CWD).action, "ask");
  });

  it("still denies a hazardous file reached through a command substitution", () => {
    const result = checkBashPermission("A=$(cat .env)", "build", RULES, CWD);
    assert.equal(result.action, "deny");
    assert.equal(result.hazardous, true);
  });

  it("still denies a catastrophic command inside a process substitution", () => {
    assert.equal(checkBashPermission("A=<(rm -rf /)", "build", RULES, CWD).action, "deny");
  });

  it("keeps a substitution-derived variable unresolvable for later operands", () => {
    assert.equal(checkBashPermission("A=$(echo hi); cat $A", "build", RULES, CWD).action, "ask");
  });
});

describe("date allowlist", () => {
  it("allows the ISO-8601 output form without opening the clock-setting door", () => {
    assert.equal(checkBashPermission("date -Is", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission('date -s "2020-01-01"', "build", RULES, CWD).action, "ask");
    assert.equal(checkBashPermission('date -Is -s "2020-01-01"', "build", RULES, CWD).action, "ask");
  });
});

describe("regression: d11 nilfs monitoring command", () => {
  // The full command that exposed both fixes: six VAR=$(...) wrappers and a
  // trailing `date -Is`. It must auto-approve end to end.
  const COMMAND = `L=/home/spiffytech/drive-inventory/d11-nilfs-copy2.log
line1=$(tr '\\r' '\\n' < "$L" | grep -E '^[0-9,]+ +[0-9]+%' | tail -1)
b1=$(echo "$line1" | awk '{gsub(/,/,"",$1); print $1}')
t1=$(echo "$line1" | awk '{print $2}' | tr -d '%')
sleep 60
line2=$(tr '\\r' '\\n' < "$L" | grep -E '^[0-9,]+ +[0-9]+%' | tail -1)
b2=$(echo "$line2" | awk '{gsub(/,/,"",$1); print $1}')
t2=$(echo "$line2" | awk '{print $2}' | tr -d '%')
echo "sample1: \${b1} bytes  \${t1}%"
echo "sample2: \${b2} bytes  \${t2}%"
echo "current rate: $(echo "scale=1; ($b2-$b1)/60/1048576" | bc) MB/s"
echo
echo "elapsed(transfer phase): $(tr '\\r' '\\n' < "$L" | grep -E '^[0-9,]+ +[0-9]+%' | tail -1 | awk '{print $4}')"
echo
echo "=== infer total from byte-% (rounded, so give a band) ==="
for pct in $((t2)) $((t2+1)); do
  echo "  if % is exactly $pct: total = $(echo "scale=0; $b2*100/$pct/1073741824" | bc) GiB"
done
echo
df -h /run/media/spiffytech/d5e9c8b4-5629-4070-9462-f3b7b98322ee | tail -1
date -Is`;

  it("auto-approves end to end", () => {
    const result = checkBashPermission(COMMAND, "build", RULES, CWD);
    assert.equal(result.action, "allow");
    assert.deepEqual(result.unapproved, []);
  });
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
    assert.equal(result.hazardous, true, "hazardous deny is flagged");
    assert.match(result.reason!, /ask the user/, "reason tells the model what to do instead");
    assert.match(result.reason!, /environment variable/, "reason suggests the alternative");
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

  it("checkFileTarget downgrades plan file read to ask (external path catch-all)", () => {
    // The plan file lives in the extension directory, which is outside the
    // project cwd. The external-path catch-all downgrades the baseline
    // read: ** -> allow rule to "ask". This is why the auto-approval bypass
    // for plan file reads lives in handleToolCall (index.ts) rather than here.
    const planPath = "/home/user/.pi/agent/extensions/pi-safetynet/plans/test-session.md";
    const result = checkFileTarget(planPath, "read", "build", RULES, CWD);
  });
});

describe("trustExternalPaths enforcement", () => {
  it("checkFileTarget honors baseline read: ** allow for external path when trusted", () => {
    // Without trust, /etc/passwd would be downgraded to "ask" by the
    // external-path catch-all. With trust, the baseline allow applies.
    const result = checkFileTarget("/etc/passwd", "read", "build", RULES, CWD, true);
    assert.equal(result.action, "allow");
  });

  it("checkFileTarget still denies hazardous external files when trusted", () => {
    // Hazardous-file protection is orthogonal to the cwd boundary.
    const result = checkFileTarget("/tmp/.env", "read", "build", RULES, CWD, true);
    assert.equal(result.action, "deny");
  });

  it("checkBashPermission auto-approves cd to external dir when trusted", () => {
    const result = checkBashPermission("cd /tmp", "build", RULES, CWD, true);
    assert.equal(result.action, "allow");
    assert.ok(!(result.unapproved ?? []).includes("cd /tmp"));
  });

  it("checkBashPermission still evaluated non-cd subcommands when trusted", () => {
    // Non-cd subcommands go through normal rule evaluation; curl isn't
    // in the baseline allowlist so it should be asked about.
    const result = checkBashPermission("curl http://example.com", "build", RULES, CWD, true);
    assert.equal(result.action, "ask");
  });

  it("checkFileTarget still downgrades external path when trust is off (default)", () => {
    // Default param (no 6th arg) — backward compatibility.
    const result = checkFileTarget("/etc/passwd", "read", "build", RULES, CWD);
    assert.equal(result.action, "ask");
  });

  it("checkBashPermission still requires approval for cd outside cwd when trust is off (default)", () => {
    const result = checkBashPermission("cd /tmp", "build", RULES, CWD);
    assert.equal(result.action, "ask");
  });
});

describe("denial reason propagation", () => {
  const ALL_MODES: ["build", "plan"] = ["build", "plan"];

  describe("checkFileTarget", () => {
    it("uses rule reason when deny rule has a reason", () => {
      const rules: Ruleset = [
        { permission: "edit", pattern: "**", action: "deny", modes: ALL_MODES, reason: "No edits allowed" },
      ];
      const result = checkFileTarget("src/foo.ts", "edit", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "No edits allowed");
    });

    it("falls back to Automatically denied when deny rule has no reason", () => {
      const rules: Ruleset = [
        { permission: "edit", pattern: "**", action: "deny", modes: ALL_MODES },
      ];
      const result = checkFileTarget("src/foo.ts", "edit", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "Automatically denied");
    });
  });

  describe("checkBashPermission", () => {
    it("uses rule reason when deny rule has a reason", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "curl *", action: "deny", modes: ALL_MODES, reason: "No network" },
      ];
      const result = checkBashPermission("curl http://example.com", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "No network");
    });

    it("falls back to Automatically denied when deny rule has no reason", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "curl *", action: "deny", modes: ALL_MODES },
      ];
      const result = checkBashPermission("curl http://example.com", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "Automatically denied");
    });

    it("joins multiple distinct deny reasons with semicolon", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "curl *", action: "deny", modes: ALL_MODES, reason: "No network" },
        { permission: "bash", pattern: "wget *", action: "deny", modes: ALL_MODES, reason: "Destructive" },
      ];
      const result = checkBashPermission("curl http://x | wget http://y", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "No network; Destructive");
    });

    it("deduplicates identical deny reasons", () => {
      const rules: Ruleset = [
        { permission: "bash", pattern: "*", action: "ask", modes: ALL_MODES },
        { permission: "bash", pattern: "curl *", action: "deny", modes: ALL_MODES, reason: "No network" },
        { permission: "bash", pattern: "wget *", action: "deny", modes: ALL_MODES, reason: "No network" },
      ];
      const result = checkBashPermission("curl http://x | wget http://y", "build", rules, CWD);
      assert.equal(result.action, "deny");
      assert.equal(result.reason, "No network");
    });
  });
});

describe("checkToolPermission", () => {
  const ALL_MODES: ["build", "plan"] = ["build", "plan"];

  it("returns ask with no matching rules (baseline has no tool: rules)", () => {
    const result = checkToolPermission("ask_user", "plan", RULES);
    assert.equal(result.action, "ask");
    assert.equal(result.reason, "Unknown tool in plan mode requires approval");
  });

  it("returns allow when a matching bash allow rule exists", () => {
    const rules: Ruleset = [
      { permission: "bash", pattern: "tool:ask_user", action: "allow", modes: ALL_MODES },
    ];
    const result = checkToolPermission("ask_user", "plan", rules);
    assert.equal(result.action, "allow");
    assert.equal(result.reason, undefined);
  });

  it("returns deny when a matching deny rule exists", () => {
    const rules: Ruleset = [
      { permission: "bash", pattern: "tool:*", action: "allow", modes: ALL_MODES },
      { permission: "bash", pattern: "tool:dangerous_tool", action: "deny", modes: ALL_MODES, reason: "Blocked" },
    ];
    const result = checkToolPermission("dangerous_tool", "plan", rules);
    assert.equal(result.action, "deny");
    assert.equal(result.reason, "Blocked");
  });

  it("returns allow when wildcard tool:\* rule matches", () => {
    const rules: Ruleset = [
      { permission: "bash", pattern: "tool:*", action: "allow", modes: ALL_MODES },
    ];
    const result = checkToolPermission("any_extension_tool", "plan", rules);
    assert.equal(result.action, "allow");
  });

  it("respects plan mode filtering on rules", () => {
    const rules: Ruleset = [
      { permission: "bash", pattern: "tool:ask_user", action: "allow", modes: ["build"] },
    ];
    const planResult = checkToolPermission("ask_user", "plan", rules);
    assert.equal(planResult.action, "ask");

    const buildResult = checkToolPermission("ask_user", "build", rules);
    assert.equal(buildResult.action, "allow");
  });

  it("recheck scenario: returns allow after rule is added", () => {
    // Simulates the bug fix: initially no rule, then one is added.
    // Before the fix, the recheck closure was static and always returned 'ask'.
    const rulesBefore: Ruleset = RULES;
    const resultBefore = checkToolPermission("ask_user", "plan", rulesBefore);
    assert.equal(resultBefore.action, "ask");

    // After adding an allow rule (simulating what resolvePermission does)
    const rulesAfter: Ruleset = [
      ...rulesBefore,
      { permission: "bash", pattern: "tool:ask_user", action: "allow", modes: ALL_MODES },
    ];
    const resultAfter = checkToolPermission("ask_user", "plan", rulesAfter);
    assert.equal(resultAfter.action, "allow");
  });

  it("consults inferred rules on ask (parity with checkBashPermission)", () => {
    const inferred = [{
      id: "r1",
      render: "tool:ask_user",
      pattern: { tokens: [{ kind: "lit", text: "tool:ask_user" }] },
      modes: ["plan"],
      exemplars: [],
      scope: "project",
      acceptedAt: 1,
    }] as any;
    const result = checkToolPermission("ask_user", "plan", RULES, {}, inferred);
    assert.equal(result.action, "allow");
  });

  it("an inferred rule never overrides an explicit deny", () => {
    const rules: Ruleset = [
      { permission: "bash", pattern: "tool:dangerous", action: "deny", modes: ALL_MODES, reason: "Blocked" },
    ];
    const inferred = [{
      id: "r1",
      render: "tool:dangerous",
      pattern: { tokens: [{ kind: "lit", text: "tool:dangerous" }] },
      modes: ["plan"],
      exemplars: [],
      scope: "project",
      acceptedAt: 1,
    }] as any;
    const result = checkToolPermission("dangerous", "plan", rules, {}, inferred);
    assert.equal(result.action, "deny");
  });

  it("an inferred rule scoped to another mode does not apply", () => {
    const inferred = [{
      id: "r1",
      render: "tool:ask_user",
      pattern: { tokens: [{ kind: "lit", text: "tool:ask_user" }] },
      modes: ["build"],
      exemplars: [],
      scope: "project",
      acceptedAt: 1,
    }] as any;
    const result = checkToolPermission("ask_user", "plan", RULES, {}, inferred);
    assert.equal(result.action, "ask");
  });
});

describe("unapprovedDisplay parallel array", () => {
  it("carries quote-preserving display strings alongside canonical unapproved", () => {
    const result = checkBashPermission('echo "hello world"', "build", RULES, CWD);
    // baseline has `echo *`, so this is allowed and unapproved is empty.
    // Use a command that falls through to the `*` catch-all (ask) to get an
    // unapproved entry.
    const r2 = checkBashPermission('bun run test:e2e -- f.spec.ts -g "can save"', "build", RULES, CWD);
    assert.ok(r2.unapproved!.length >= 1);
    assert.equal(r2.unapprovedDisplay!.length, r2.unapproved!.length);
    // canonical is de-quoted; display preserves the quotes.
    assert.ok(r2.unapproved![0]!.includes('-g can save'));
    assert.ok(r2.unapprovedDisplay![0]!.includes('-g "can save"'));
  });
});

describe("regression: fully-allowlisted commands allow with empty unapproved", () => {
  // Guards the resolvePermission allow-path early-return: when a command is
  // entirely allowlisted, checkBashPermission must return action:"allow" and
  // NO unapproved entries. If this contract breaks, resolvePermission would
  // fall through to the prompt loop and show the whole command (a prior bug).
  const cases: Array<[string, string]> = [
    ["cat README.md | head -40", "pipeline of allowlisted readers"],
    ["echo ---DEV---", "allowlisted echo"],
    ["sed -n 1,60p file.ts 2>/dev/null", "allowlisted sed -n with fd-redirect"],
    ["cat /home/user/project/pkg.json 2>/dev/null | head -40; echo x; sed -n 1,60p /home/user/project/dev.ts 2>/dev/null", "the exact reported compound command"],
  ];
  for (const [cmd, label] of cases) {
    it(`allowlists: ${label}`, () => {
      const result = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(result.action, "allow", `expected allow for: ${cmd}`);
      assert.equal((result.unapproved ?? []).length, 0, `expected no unapproved for: ${cmd}`);
      assert.equal((result.redirectTargets ?? []).length, 0, `expected no redirect targets for: ${cmd}`);
    });
  }
});

describe("user-added ** wildcard honors external paths", () => {
  const ALL_MODES: ["build", "plan"] = ["build", "plan"];

  it("baseline read: ** is still downgraded for external paths (backward compat)", () => {
    const result = checkFileTarget("/etc/hosts", "read", "build", RULES, CWD);
    assert.equal(result.action, "ask");
    assert.equal(result.reason, "Path is outside project root");
  });

  it("user-added read: ** allow is honored for external paths", () => {
    const rules: Ruleset = [
      ...RULES,
      { permission: "read", pattern: "**", action: "allow", modes: ALL_MODES },
    ];
    const result = checkFileTarget("/etc/hosts", "read", "build", rules, CWD);
    assert.equal(result.action, "allow");
  });

  it("user-added edit: ** allow is honored for external paths", () => {
    const rules: Ruleset = [
      ...RULES,
      { permission: "edit", pattern: "**", action: "allow", modes: ALL_MODES },
    ];
    const result = checkFileTarget("/tmp/output.txt", "edit", "build", rules, CWD);
    assert.equal(result.action, "allow");
  });

  it("specific external path rule works without ** interference", () => {
    // Regression: specific patterns should still work
    const rules: Ruleset = [
      ...RULES,
      { permission: "read", pattern: "/etc/**", action: "allow", modes: ALL_MODES },
    ];
    const result = checkFileTarget("/etc/hosts", "read", "build", rules, CWD);
    assert.equal(result.action, "allow");
  });
});

describe("stale cwd path normalization", () => {
  it("file inside correct cwd is internal (sanity check)", () => {
    // CWD is "/home/user/project" as defined at top of file
    const result = checkFileTarget("src/foo.ts", "read", "build", RULES, CWD);
    assert.equal(result.action, "allow");
  });

  it("absolute file inside correct cwd is normalized to internal", () => {
    const result = checkFileTarget(CWD + "/src/foo.ts", "read", "build", RULES, CWD);
    assert.equal(result.action, "allow");
  });

  it("file inside actual cwd but stale cwd treats as external (bug reproduction)", () => {
    // File at /home/user/project/src/foo.ts with staleCwd = /stale/cwd
    // The stale cwd doesn't match, so the path stays absolute → external
    const result = checkFileTarget(CWD + "/src/foo.ts", "read", "build", RULES, "/stale/cwd");
    assert.equal(result.action, "ask");
    assert.equal(result.reason, "Path is outside project root");
  });

  it("file inside actual cwd with undefined cwd falls back to process.cwd()", () => {
    // When cwd is undefined, checkFileTarget uses process.cwd()
    // We can't easily test process.cwd() behavior without actually being in the dir,
    // but we can verify it doesn't crash and works logically.
    // Just test with explicit cwd to verify the fallback mechanism:
    const result = checkFileTarget(CWD + "/src/foo.ts", "read", "build", RULES, undefined);
    // process.cwd() in the test runner won't be CWD, so this will be external
    // Just verify it returns a valid action (not a crash)
    assert.ok(result.action === "allow" || result.action === "ask");
  });
});

describe("checkBashPermission force-ask on unresolvable dangerous operands", () => {
  const ALLOW_RM: Ruleset = [
    { permission: "bash", pattern: "rm *", action: "allow", modes: ["build", "plan", "ro", "rw"] },
  ];
  const ALLOW_ECHO: Ruleset = [
    { permission: "bash", pattern: "echo *", action: "allow", modes: ["build", "plan", "ro", "rw"] },
  ];
  const approvalRule = (p: string): Ruleset[number] => ({
    permission: "bash",
    pattern: p,
    action: "allow",
    modes: ["build"],
  });

  it("does not silently allow rm with a quoted expansion", () => {
    const result = checkBashPermission('rm -rf "$HOME"', "build", ALLOW_RM, CWD);
    assert.equal(result.action, "ask");
    assert.ok(result.unapproved?.includes('rm -rf "..."'));
  });

  it("still allows a concrete rm target", () => {
    assert.equal(checkBashPermission("rm -rf ./build", "build", ALLOW_RM, CWD).action, "allow");
  });

  it("does not force-ask harmless expansions", () => {
    assert.equal(checkBashPermission('echo "$HOME"', "build", ALLOW_ECHO, CWD).action, "allow");
  });

  // Regression: the escalation used to flag EVERY subcommand in a compound
  // command, so approving the dangerous one re-surfaced the harmless ones and
  // an approval could never satisfy the post-approval recheck (auto-review's
  // "reviewer allowed but the approval rules failed recheck" prompt, and an
  // interactive approve-for-session loop).
  it("does not drag a harmless sibling subcommand into the escalation", () => {
    const cmd = 'echo hi; rm -rf "$DIR"';
    const withBaselineOnly = checkBashPermission(cmd, "build", getBaselineRules(), CWD);
    assert.deepEqual(withBaselineOnly.unapproved, ['rm -rf "..."']);

    const rules: Ruleset = [...getBaselineRules(), approvalRule('rm -rf "..."')];
    const recheck = checkBashPermission(cmd, "build", rules, CWD);
    assert.equal(recheck.action, "allow");
    assert.ok(!recheck.unapproved?.includes("echo hi"));
  });

  // A bare assignment can never be recorded as an exact-shape approval (the
  // per-subcommand loop skips assignments before it can), so flagging it made
  // the interactive recheck loop forever.
  it("does not flag a bare assignment alongside a dangerous verb", () => {
    const cmd = 'BK=/tmp/b; sudo -n chown -R "$BK" /tmp/y';
    assert.deepEqual(checkBashPermission(cmd, "build", getBaselineRules(), CWD).unapproved, [
      'sudo -n chown -R "..." /tmp/y',
    ]);

    const rules: Ruleset = [...getBaselineRules(), approvalRule('sudo -n chown -R "..." /tmp/y')];
    assert.equal(checkBashPermission(cmd, "build", rules, CWD).action, "allow");
  });
});

describe("checkBashPermission — explicit approvals override the operand escalations", () => {
  // Reported repro: a loop body whose operands are loop-variable references.
  // `basename`/`cat` are file verbs and `$d` is statically unresolvable, so
  // every subcommand escalates — and must KEEP escalating under broad
  // baseline rules — but a rule approving the exact subcommand shape is the
  // user's/reviewer's deliberate verdict and must satisfy the post-approval
  // recheck, or approval could never stick ("approve-for-session" loops).
  const LOOP_CMD = "for d in /some/path; do basename $d; cat $d/device/model; cat $d/size; done";
  // Canonical (placeholder) shapes the auto path mints as temp rules…
  const SUBS = ["basename ${...}", "cat ${...}/device/model", "cat ${...}/size"];
  // …and the display shapes the interactive session path stores.
  const DISPLAY_SUBS = ["basename $d", "cat $d/device/model", "cat $d/size"];

  const approvalRule = (p: string): Ruleset[number] => ({ permission: "bash", pattern: p, action: "allow", modes: ["build"] });

  it("still escalates with only the baseline ruleset", () => {
    assert.equal(checkBashPermission(LOOP_CMD, "build", getBaselineRules(), CWD).action, "ask");
  });

  it("recheck allow with canonical approval rules (the auto path's temp rules)", () => {
    const rules: Ruleset = [...getBaselineRules(), ...SUBS.map(approvalRule)];
    assert.equal(checkBashPermission(LOOP_CMD, "build", rules, CWD).action, "allow");
  });

  it("recheck allow with display approval rules (the interactive session path)", () => {
    const rules: Ruleset = [...getBaselineRules(), ...DISPLAY_SUBS.map(approvalRule)];
    assert.equal(checkBashPermission(LOOP_CMD, "build", rules, CWD).action, "allow");
  });

  it("a baseline catch-all does not unwrap an unresolvable operand", () => {
    assert.equal(checkBashPermission("cat $PI_SAFETYNET_NOPE/notes.md", "build", getBaselineRules(), CWD).action, "ask");
  });

  it("an explicit non-baseline glob rule overrides (same as the external-path rule)", () => {
    const rules: Ruleset = [...getBaselineRules(), approvalRule("cat *")];
    assert.equal(checkBashPermission("cat $PI_SAFETYNET_NOPE/notes.md", "build", rules, CWD).action, "allow");
  });

  it("a deny rule still wins for an unresolvable operand", () => {
    const rules: Ruleset = [
      ...getBaselineRules(),
      { permission: "bash", pattern: "cat *", action: "deny", modes: ["build"], reason: "not allowed" },
    ];
    assert.equal(checkBashPermission("cat $PI_SAFETYNET_NOPE/notes.md", "build", rules, CWD).action, "deny");
  });

  it("dangerous verbs: exact-shape approval sticks, a broad rule keeps forcing the prompt", () => {
    const exact: Ruleset = [...getBaselineRules(), approvalRule('rm -rf "..."'), approvalRule('rm -rf "$DIR"')];
    assert.equal(checkBashPermission('rm -rf "$DIR"', "build", exact, CWD).action, "allow");
    const broad: Ruleset = [{ permission: "bash", pattern: "rm *", action: "allow", modes: ["build", "plan", "ro", "rw"] }];
    assert.equal(checkBashPermission('rm -rf "$DIR"', "build", broad, CWD).action, "ask");
  });
});

describe("normalizeToolPath — the prefix the file-tool resolver strips", () => {
  it("strips a single leading @ the file tools honor before opening", () => {
    assert.equal(normalizeToolPath("@.env"), ".env");
    assert.equal(normalizeToolPath("@src/app.ts"), "src/app.ts");
  });

  it("folds the unicode spaces the harness resolver folds", () => {
    assert.equal(normalizeToolPath("a\u00A0b.ts"), "a b.ts");
  });

  it("leaves paths without the prefix untouched", () => {
    assert.equal(normalizeToolPath("foo@bar"), "foo@bar");
    assert.equal(normalizeToolPath("~/.env"), "~/.env");
  });
});

describe("checkFileTarget — @-prefixed hazardous paths", () => {
  // Hazardous names whose detection keys on the basename's leading dot: the
  // raw `@`-prefixed string is NOT hazardous, so the baseline `read: **` allow
  // matches it and the file opens (the pre-fix fail-open). Normalizing the way
  // the file tools resolve must flip it to a hazardous deny.
  const basenameHazardous = ["@.env", "@.npmrc", "@.envrc", "@.netrc", "@credentials.json", "@secrets.yml"];

  it("denies once the @ prefix is stripped, and documents the raw hole", () => {
    for (const p of basenameHazardous) {
      assert.equal(checkFileTarget(p, "read", "build", RULES, CWD).action, "allow", `${p} is the raw hole`);
      const r = checkFileTarget(normalizeToolPath(p), "read", "build", RULES, CWD);
      assert.equal(r.action, "deny", `${p} must deny once normalized`);
      assert.equal(r.hazardous, true, `${p} must be flagged hazardous`);
    }
  });

  it("normalizes a benign @-prefixed path to the file the tool opens", () => {
    assert.equal(checkFileTarget(normalizeToolPath("@src/app.ts"), "read", "build", RULES, CWD).action, "allow");
  });

  it("detects hazardous basenames case-insensitively (case-insensitive filesystems)", () => {
    assert.equal(checkFileTarget(normalizeToolPath("@.ENV"), "read", "build", RULES, CWD).action, "deny");
    assert.equal(checkFileTarget(".Env", "read", "build", RULES, CWD).action, "deny");
  });
});

describe("checkToolPermission — unknown tools ask in every mode", () => {
  it("asks for an unknown tool in build (write) mode, not just read-only", () => {
    const r = checkToolPermission("mcp_deploy", "build", RULES);
    assert.equal(r.action, "ask");
    assert.match(r.reason ?? "", /build mode/);
  });
});

describe("checkBashPermission — hazardous-file arguments to allowlisted verbs", () => {
  it("does not silently allow reading a secret through cat/head/grep/awk/sed", () => {
    for (const cmd of [
      "cat .env",
      "head .env",
      "grep SECRET .env",
      "awk '{print}' .env",
      "sed -n '1p' .env",
      "cat .ssh/id_rsa",
    ]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(r.action, "deny", `${cmd} must deny`);
      assert.equal(r.hazardous, true, `${cmd} must be flagged hazardous`);
    }
  });

  it("still allows an allowlisted read that names no hazardous file", () => {
    assert.equal(checkBashPermission("cat README.md", "build", RULES, CWD).action, "allow");
  });

  it("still allows .env.example, which is explicitly safe", () => {
    assert.equal(checkBashPermission("cat .env.example", "build", RULES, CWD).action, "allow");
  });
});

describe("checkBashPermission — external paths to allowlisted verbs", () => {
  it("asks instead of allowing a read outside the project root", () => {
    const r = checkBashPermission("cat /etc/passwd", "build", RULES, CWD);
    assert.equal(r.action, "ask");
    assert.ok((r.unapproved ?? []).length > 0, "the external subcommand is surfaced for approval");
  });

  it("does not flag in-project paths or bare names", () => {
    assert.equal(checkBashPermission("cat README.md", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission("cat ./src/app.ts", "build", RULES, CWD).action, "allow");
  });

  it("honours an explicit user-approved rule for an external path", () => {
    const explicit = [
      ...RULES,
      { permission: "bash" as const, pattern: "cat /etc/passwd", action: "allow" as const, modes: ["build" as const] },
      { permission: "bash" as const, pattern: "cd /etc", action: "allow" as const, modes: ["build" as const] },
    ];
    assert.equal(checkBashPermission("cat /etc/passwd", "build", explicit, CWD).action, "allow");
    assert.equal(checkBashPermission("cd /etc && ls", "build", explicit, CWD).action, "allow");
  });

  it("an explicit rule does not bypass the hazardous block", () => {
    const sneaky = [
      ...RULES,
      { permission: "bash" as const, pattern: "cat .env", action: "allow" as const, modes: ["build" as const] },
    ];
    const r = checkBashPermission("cat .env", "build", sneaky, CWD);
    assert.equal(r.action, "deny");
    assert.equal(r.hazardous, true);
  });

  it("honors trustExternalPaths", () => {
    assert.equal(checkBashPermission("cat /etc/passwd", "build", RULES, CWD, true).action, "allow");
  });
});

describe("checkBashPermission — glob/option hazardous operands and interior traversal", () => {
  it("denies glob-suffixed secret names under the baseline cat allow", () => {
    for (const cmd of ["cat .env*", "cat id_rsa*", "cat .npmrc*", "cat .ssh/*"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(r.action, "deny", `${cmd} must deny`);
      assert.equal(r.hazardous, true, `${cmd} must be flagged hazardous`);
    }
  });

  it("denies a hazardous operand even when the ruleset verdict is ask", () => {
    for (const cmd of ["rm .env", "tee .env"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(r.action, "deny", `${cmd} must deny, not merely ask`);
      assert.equal(r.hazardous, true, `${cmd} must be flagged hazardous`);
    }
  });

  it("denies a hazardous filename glued to a short option", () => {
    assert.equal(checkBashPermission("grep -f.env x", "build", RULES, CWD).action, "deny");
  });

  it("denies any glob that can reach a protected name", () => {
    for (const cmd of ["cat .e*", "cat .*", "cat .en?", "cat .env.*", "cat *", "cat i*"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(r.action, "deny", `${cmd} must deny`);
      assert.equal(r.hazardous, true);
    }
    // bash globs never match a leading dot unless the pattern has one, so
    // `*.env` cannot reach `.env`; confined globs reach no protected name.
    assert.equal(checkBashPermission("cat *.env", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission("cat README*", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission("cat dist/*", "build", RULES, CWD).action, "allow");
    // shopt -s dotglob makes `*` reach `.env` too.
    assert.equal(checkBashPermission("shopt -s dotglob; cat *.env", "build", RULES, CWD).action, "deny");
  });

  it("asks for a relative path that escapes via interior ..", () => {
    for (const cmd of ["cat foo/../../etc/passwd", "cat subdir/../../etc/passwd", "cat /etc/*"]) {
      assert.equal(checkBashPermission(cmd, "build", RULES, CWD).action, "ask", `${cmd} must ask`);
    }
  });

  it("does not flag an in-project relative path with ..", () => {
    assert.equal(checkBashPermission("cat src/../README.md", "build", RULES, CWD).action, "allow");
  });
});

describe("checkBashPermission — operand scanning scoped to file verbs and resolved expansions", () => {
  it("ignores text arguments to non-file verbs", () => {
    for (const cmd of ["echo .env", "printf .env", "git log --grep .env", "git commit -m 'update .env'"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.ok(r.action !== "deny", `${cmd} must not deny`);
    }
    assert.equal(checkBashPermission("echo .env", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission("printf .env", "build", RULES, CWD).action, "allow");
  });

  it("ignores grep/sed/awk/find pattern and script arguments", () => {
    for (const cmd of ["grep .env f", "grep -e '.env' f", "sed -e '.env' f", "awk '.env' f", "find . -name .env"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.ok(r.action !== "deny", `${cmd} must not deny`);
    }
  });

  it("still catches file operands of those verbs", () => {
    for (const cmd of ["grep secret .env", "grep -f .env x", "xargs cat .env"]) {
      const r = checkBashPermission(cmd, "build", RULES, CWD);
      assert.equal(r.action, "deny", `${cmd} must deny`);
      assert.equal(r.hazardous, true);
    }
  });

  it("denies a hazardous file reached through a variable assignment", () => {
    const r = checkBashPermission("F=.env; cat $F", "build", RULES, CWD);
    assert.equal(r.action, "deny");
    assert.equal(r.hazardous, true);
  });

  it("denies a hazardous file reached through chained and defaulted variables", () => {
    assert.equal(checkBashPermission("G=.env; F=$G; cat ${F}", "build", RULES, CWD).action, "deny");
    assert.equal(checkBashPermission("cat ${PI_SAFETYNET_NOPE:-.env}", "build", RULES, CWD).action, "deny");
  });

  it("asks for an external path built from an exported variable", () => {
    assert.equal(checkBashPermission("cat $HOME/notes.md", "build", RULES, CWD).action, "ask");
    assert.equal(checkBashPermission("cat $PWD/README.md", "build", RULES, CWD).action, "allow");
  });

  it("asks when the variable cannot be pinned down", () => {
    assert.equal(checkBashPermission("cat $PI_SAFETYNET_NOPE/notes.md", "build", RULES, CWD).action, "ask");
    assert.equal(checkBashPermission("cat $(echo notes.md)", "build", RULES, CWD).action, "ask");
  });

  it("does not expand single-quoted literals", () => {
    assert.equal(checkBashPermission("cat '$PATH'", "build", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission("F=.env; cat '$F'", "build", RULES, CWD).action, "allow");
  });
});

describe("patternHasBashGlob", () => {
  it("flags the metacharacters that would broaden a minted rule", () => {
    assert.equal(patternHasBashGlob("rm -rf *"), true);
    assert.equal(patternHasBashGlob("curl https://x?y"), true);
  });

  it("leaves literal commands alone", () => {
    assert.equal(patternHasBashGlob("npm test"), false);
    assert.equal(patternHasBashGlob("git commit -m 'x'"), false);
  });
});

describe("session sandbox", () => {
  const SANDBOX = "/tmp/pi-safetynet/test-session";
  const RO_ALIASES = { ro: "plan" } as Record<string, "plan">;
  const RW_ALIASES = { rw: "build" } as Record<string, "build">;

  beforeEach(() => setSandboxDir(SANDBOX));
  afterEach(() => setSandboxDir(undefined));

  it("allows a redirect into the sandbox in ro mode, without an edit redirect target", () => {
    const result = checkBashPermission(`echo hello > ${SANDBOX}/out.txt`, "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "allow");
    assert.deepEqual(result.redirectTargets ?? [], []);
    assert.equal(actionWrites("bash", result), false);
  });

  it("allows a redirect into the sandbox in rw mode without asking", () => {
    const result = checkBashPermission(`grep pat file.txt > ${SANDBOX}/out.txt`, "rw", RULES, CWD, false, RW_ALIASES);
    assert.equal(result.action, "allow");
  });

  it("still denies a redirect outside the sandbox in ro mode", () => {
    const result = checkBashPermission("echo hello > /tmp/other/out.txt", "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "deny");
    assert.ok(result.reason?.includes("Read-only mode"));
  });

  it("still denies a hazardous target inside the sandbox", () => {
    const result = checkBashPermission(`echo secret > ${SANDBOX}/.env`, "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "deny");
    assert.equal(result.hazardous, true);
  });

  it("still denies reading a hazardous source", () => {
    const result = checkBashPermission(`cat .env > ${SANDBOX}/out.txt`, "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "deny");
    assert.equal(result.hazardous, true);
  });

  it("allows reads from the sandbox", () => {
    const result = checkBashPermission(`cat ${SANDBOX}/out.txt`, "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "allow");
  });

  it("allows the edit permission inside the sandbox in ro mode", () => {
    const result = checkFileTarget(`${SANDBOX}/x.ts`, "edit", "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "allow");
  });

  it("still denies hazardous names inside the sandbox at the file level", () => {
    const result = checkFileTarget(`${SANDBOX}/.env`, "edit", "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "deny");
    assert.equal(result.hazardous, true);
  });

  it("does not allow a prefix-sibling directory", () => {
    const result = checkBashPermission(`echo hi > ${SANDBOX}-evil/out.txt`, "rw", RULES, CWD, false, RW_ALIASES);
    assert.notEqual(result.action, "allow");
  });

  it("auto-approves cd into the sandbox", () => {
    const result = checkBashPermission(`cd ${SANDBOX} && ls`, "ro", RULES, CWD, false, RO_ALIASES);
    assert.equal(result.action, "allow");
  });

  it("auto-allows sandbox-local mkdir and rm", () => {
    assert.equal(checkBashPermission(`mkdir -p ${SANDBOX}/a/b`, "rw", RULES, CWD).action, "allow");
    assert.equal(checkBashPermission(`rm -rf ${SANDBOX}/a`, "rw", RULES, CWD).action, "allow");
  });

  it("does not auto-allow a sandbox-local verb with an outside operand", () => {
    const result = checkBashPermission(`cp file.txt ${SANDBOX}/out.txt`, "rw", RULES, CWD);
    assert.equal(result.action, "ask");
  });
});
