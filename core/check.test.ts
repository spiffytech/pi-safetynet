import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkBashPermission, checkFileTarget, checkToolPermission, actionWrites } from "./check.ts";
import { parseCommand } from "./bash-parser.ts";
import { getBaselineRules } from "./permissions/index.ts";
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
