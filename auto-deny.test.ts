import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolvePermission, denialDetail, denialGuidance, denialMessage, targetTouchesHazardousPath, buildApprovalRules } from "./pipeline.ts";
import { checkFileTarget } from "./core/check.ts";
import { setAutoEnabled } from "./core/auto-config-state.ts";
import { resetReviewStateForTests } from "./core/reviewer-state.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Test scaffolding ──────────────────────────────────────────────────────
//
// The pipeline reads review config from ~/.config/pi-safetynet/config.json via
// os.homedir(). We point HOME at a temp dir with a tiny timeoutMs so the
// reviewer-timeout timer doesn't make the suite wait ~90s per call.

const TMP_HOME = join(process.cwd(), ".test-tmp-home-deny");
const originalHome = process.env.HOME;

const CONFIG = {
  autoApprove: { timeoutMs: 100, maxDenials: 3, retryIntervalMs: 50, maxRetries: 1 },
};

beforeEach(() => {
  process.env.HOME = TMP_HOME;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
  writeFileSync(
    join(TMP_HOME, ".config", "pi-safetynet", "config.json"),
    JSON.stringify(CONFIG),
    "utf-8",
  );
  setAutoEnabled(false, { appendEntry: () => {} } as any);
  resetReviewStateForTests();
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
});

/** Minimal displayCtx mock: tracks abort + notifies. */
function makeCtx(overrides: Record<string, unknown> = {}) {
  const aborted = { value: false };
  const notifies: string[] = [];
  return {
    aborted,
    notifies,
    hasUI: true,
    ui: {
      notify: (m: string) => notifies.push(m),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      // Default: any prompt resolves null immediately (dismissed). Tests that
      // need a delayed dismissal override `custom` with a timed promise.
      custom: async () => null,
    },
    abort() { aborted.value = true; },
    sessionManager: { getEntries: () => [] },
    ...overrides,
  };
}

/** Minimal storage mock (same shape as subagent-safetynet.test.ts). */
function makeStorage() {
  const stores = {
    session: { rules: [] as any[], getRules() { return [...this.rules]; }, addRules(r: any[]) { this.rules.push(...r); }, clear() { this.rules = []; } },
    persisted: { rules: [] as any[], getRules() { return [...this.rules]; }, addRules(r: any[]) { this.rules.push(...r); }, clear() { this.rules = []; } },
    global: { rules: [] as any[], getRules() { return [...this.rules]; }, addRules(r: any[]) { this.rules.push(...r); }, clear() { this.rules = []; } },
    flag: { rules: [] as any[], getRules() { return [...this.rules]; }, addRules(r: any[]) { this.rules.push(...r); }, clear() { this.rules = []; } },
    temp: {
      _rules: [] as any[],
      getRules() { return this._rules.map((r: any) => r.rule); },
      addRules(r: any[]) { this._rules.push(...r); },
      clearTurnRules() { this._rules = this._rules.filter((r: any) => r.expiry.type !== "turn"); },
      clear() { this._rules = []; },
    },
  };
  return {
    ...stores,
    getAllRules() { return [...stores.session.getRules(), ...stores.persisted.getRules(), ...stores.global.getRules(), ...stores.flag.getRules(), ...stores.temp.getRules()]; },
    addSessionRules(r: any[]) { stores.session.addRules(r); },
    addFlagRules(r: any[]) { stores.flag.addRules(r); },
    addTempRules(r: any[]) { stores.temp.addRules(r); },
    async addPersistedRules(r: any[]) { stores.persisted.addRules(r); },
    async addGlobalRules(r: any[]) { stores.global.addRules(r); },
    async init() {},
  } as any;
}

/** Fake reviewer spawn: returns canned assessments; ignores its opts. */
function makeReviewSpawn(verdicts: any[]) {
  let i = 0;
  return async () => {
    const v = verdicts[Math.min(i++, verdicts.length - 1)]!;
    return {
      content: [{ type: "text", text: JSON.stringify(v.assessment) }],
      details: {},
    };
  };
}

function denyAssessment(rationale = "destructive and not user-authorized") {
  return {
    kind: "assessment" as const,
    assessment: {
      risk_level: "critical" as const,
      user_authorization: "unknown" as const,
      outcome: "deny" as const,
      rationale,
    },
  };
}

const ASK_CHECK = { action: "ask" as const };
const ASK_RECHECK = () => ({ action: "ask" as const });

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    displayCtx: makeCtx(),
    storage: makeStorage(),
    cwd: "/tmp",
    allowModes: ["build"],
    keybindings: { denyAbort: "escape" },
    autoDeny: {} as Record<string, unknown>,
    sendManualApproval: () => {},
    ...overrides,
  } as any;
}

// ─── denialDetail (pure) ────────────────────────────────────────────────────

describe("denialDetail", () => {
  it("labels reviewer denials with Auto-denied", () => {
    assert.equal(
      denialDetail("bash", "rm -rf /tmp/data", "destructive"),
      "Auto-denied bash: rm -rf /tmp/data — destructive",
    );
  });

  it("labels ruleset denials with Ruleset denied", () => {
    assert.equal(
      denialDetail("read", "/etc/passwd", "Hazardous file", "ruleset"),
      "Ruleset denied read: /etc/passwd — Hazardous file",
    );
  });

  it("labels headless denials with Denied", () => {
    assert.equal(
      denialDetail("edit", "x", "requires approval", "headless"),
      "Denied edit: x — requires approval",
    );
  });
});

// ─── denialGuidance / denialMessage (pure) ────────────────────────────────

describe("denialGuidance / denialMessage", () => {
  it("gives every source a corrective instruction", () => {
    for (const source of ["reviewer", "ruleset", "headless", "mode"] as const) {
      const guidance = denialGuidance(source);
      assert.ok(guidance.length > 0, `${source} must carry guidance`);
      assert.match(guidance, /do not retry|continue without it|let the user/i, `${source} guides recovery`);
    }
  });

  it("composes label + reason + guidance", () => {
    const detail = denialDetail("read", "/etc/passwd", "Hazardous file", "ruleset");
    const guidance = denialGuidance("ruleset");
    assert.equal(
      denialMessage("read", "/etc/passwd", "Hazardous file", "ruleset"),
      `${detail} ${guidance}`,
    );
  });
});

// ─── Reviewer denials (auto mode) ───────────────────────────────────────────

describe("resolvePermission — reviewer deny", () => {
  it("non-abort deny: sends hidden nudge only, no abort, enriched block reason", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        sendDenial: (t: string, m: string) => denials.push([t, m]),
        reviewSpawn: makeReviewSpawn([denyAssessment()]),
      }),
      { permission: "bash", target: "rm -rf /tmp/data", check: ASK_CHECK, recheck: ASK_RECHECK },
    );

    assert.equal(ctx.aborted.value, false, "first deny must not abort");
    assert.deepEqual(denials, [
      [denialMessage("bash", "rm -rf /tmp/data", "destructive and not user-authorized", "reviewer"), "hidden"],
    ]);
    assert.ok(result, "block result returned");
    assert.match(result!.reason, /rm -rf \/tmp\/data/, "reason names the target");
    assert.match(result!.reason, /destructive/, "reason carries the rationale");
    assert.ok(
      !/risk_level|user_authorization|risk=|auth=/i.test(result!.reason),
      "surfaced reason must NOT include risk/auth scoring",
    );
  });

  it("deny defaults to aborting after maxDenials strikes, with visible entry", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      sendDenial: (t: string, m: string) => denials.push([t, m]),
      reviewSpawn: makeReviewSpawn([denyAssessment(), denyAssessment(), denyAssessment()]),
    });

    for (let i = 0; i < 3; i++) {
      await resolvePermission(
        deps,
        { permission: "bash", target: "rm -rf /tmp/data", check: ASK_CHECK, recheck: ASK_RECHECK },
      );
    }

    const hidden = denials.filter(([, m]) => m === "hidden");
    const visible = denials.filter(([, m]) => m === "visible");
    assert.equal(hidden.length, 3, "every strike gets a hidden nudge");
    assert.equal(visible.length, 1, "only the aborting strike gets a visible entry");
    assert.equal(ctx.aborted.value, true, "third strike aborts the turn");

    const visibleText = visible[0]![0];
    assert.match(visibleText, /rm -rf \/tmp\/data/, "visible entry names the target");
    assert.match(visibleText, /destructive/, "visible entry carries the rationale");
    assert.ok(!/risk_level|user_authorization|risk=|auth=/i.test(visibleText), "visible entry must NOT include risk/auth");
  });
});

// ─── targetTouchesHazardousPath (pure) ─────────────────────────────────────

describe("targetTouchesHazardousPath", () => {
  it("matches hazardous paths as file targets and as bash arguments", () => {
    assert.equal(targetTouchesHazardousPath("read", "/home/x/.env"), true);
    assert.equal(targetTouchesHazardousPath("bash", "cat .env"), true);
    assert.equal(targetTouchesHazardousPath("bash", "cat --file=.env"), true);
    assert.equal(targetTouchesHazardousPath("bash", "cat /home/x/.ssh/id_rsa"), true);
    assert.equal(targetTouchesHazardousPath("bash", "grep SECRET credentials.json"), true);
  });

  it("does not match non-hazardous targets", () => {
    assert.equal(targetTouchesHazardousPath("bash", "cat .env.example"), false);
    assert.equal(targetTouchesHazardousPath("bash", "ls -la src"), false);
    assert.equal(targetTouchesHazardousPath("read", "src/index.ts"), false);
  });
});

// ── Reviewer denies a hazardous target (never abort) ──────────────────────

describe("resolvePermission — reviewer deny of a secret-touching command", () => {
  it("never aborts on secret-touching commands", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      reviewSpawn: makeReviewSpawn([denyAssessment()]),
      sendDenial: () => {},
    });
    const secret = { permission: "bash" as const, target: "cat .env", check: ASK_CHECK, recheck: ASK_RECHECK };

    for (let i = 0; i < 5; i++) {
      const r = await resolvePermission(deps, secret);
      assert.equal(ctx.aborted.value, false, `secret denial ${i + 1} must not abort`);
      assert.equal(r?.block, true, "still blocked");
    }
  });

  it("does not consume the reviewer budget for later non-secret denials", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      reviewSpawn: makeReviewSpawn([denyAssessment()]),
      sendDenial: () => {},
    });
    const secret = { permission: "bash" as const, target: "cat .env", check: ASK_CHECK, recheck: ASK_RECHECK };
    const plain = { permission: "bash" as const, target: "rm -rf /tmp/data", check: ASK_CHECK, recheck: ASK_RECHECK };

    for (let i = 0; i < 4; i++) await resolvePermission(deps, secret);
    assert.equal(ctx.aborted.value, false, "secret denials alone never abort");

    await resolvePermission(deps, plain);
    await resolvePermission(deps, plain);
    assert.equal(ctx.aborted.value, false, "reviewer budget untouched by secret denials");
    await resolvePermission(deps, plain);
    assert.equal(ctx.aborted.value, true, "third non-secret reviewer denial aborts");
  });
});

// ─── Ruleset denials (deny rules) ───────────────────────────────────────────

describe("resolvePermission — deny rule", () => {
  it("continue:false — hidden nudge per strike, visible entry + abort on the 3rd", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });
    const opts = {
      permission: "read" as const,
      target: "/etc/passwd",
      check: { action: "deny" as const, reason: "Hazardous file" },
      recheck: () => ({ action: "deny" as const }),
    };

    let result: { block: boolean; reason: string } | undefined;
    for (let i = 0; i < 3; i++) result = await resolvePermission(deps, opts);

    const line = denialMessage("read", "/etc/passwd", "Hazardous file", "ruleset");
    assert.equal(ctx.aborted.value, true, "continue:false aborts once maxStrikes is reached");
    assert.deepEqual(denials, [
      [line, "hidden"],
      [line, "hidden"],
      [line, "hidden"],
      [line, "visible"],
    ]);
    assert.equal(result?.reason, line);
  });

  it("continue:true — hidden nudge only, no abort", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: true },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      {
        permission: "bash",
        target: "curl http://example.com",
        check: { action: "deny" as const, reason: "Project policy: no network" },
        recheck: () => ({ action: "deny" as const }),
      },
    );

    const line = denialMessage("bash", "curl http://example.com", "Project policy: no network", "ruleset");
    assert.equal(ctx.aborted.value, false, "continue:true keeps the turn alive");
    assert.deepEqual(denials, [
      [line, "hidden"],
    ]);
    assert.equal(result?.reason, line);
  });
});

// ─── Hazardous-file denials (block, never abort) ──────────────────────────

describe("resolvePermission — hazardous deny", () => {
  const HAZ_CHECK = { action: "deny" as const, reason: "Sensitive file", hazardous: true };

  it("1st hazardous deny: hidden nudge only, no abort, even with continue:false", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: false },
        hazardousDenyState: { count: 0 },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK },
    );

    const line = denialMessage("read", "/etc/passwd", "Sensitive file", "ruleset");
    assert.equal(ctx.aborted.value, false, "1st hazardous deny must NOT abort");
    assert.deepEqual(denials, [
      [line, "hidden"],
    ]);
    assert.equal(result?.reason, line);
  });

  it("never aborts, however many attempts, and never emits a visible entry", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const state = { count: 0 };
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: state,
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });

    for (let i = 0; i < 6; i++) {
      await resolvePermission(deps, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });
    }

    assert.equal(ctx.aborted.value, false, "hazardous denials never abort the turn");
    assert.equal(denials.length, 6, "one hidden nudge per attempt");
    assert.ok(denials.every(([, m]) => m === "hidden"), "no visible entry: nothing aborts");
    assert.equal(state.count, 0, "hazardous denials do not consume the strike budget");
  });

  it("does not consume the budget: ruleset strikes still start at zero after hazardous denials", async () => {
    const ctx = makeCtx();
    const state = { count: 0 };
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: state,
      sendDenial: () => {},
    });
    const hazOpts = { permission: "read" as const, target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK };
    const ruleOpts = {
      permission: "bash" as const,
      target: "curl http://example.com",
      check: { action: "deny" as const, reason: "Project policy: no network" },
      recheck: () => ({ action: "deny" as const }),
    };

    for (let i = 0; i < 3; i++) await resolvePermission(deps, hazOpts);
    assert.equal(ctx.aborted.value, false, "hazardous denials alone never abort");

    await resolvePermission(deps, ruleOpts);
    await resolvePermission(deps, ruleOpts);
    assert.equal(ctx.aborted.value, false, "ruleset strikes did not inherit the hazardous attempts");
    await resolvePermission(deps, ruleOpts);
    assert.equal(ctx.aborted.value, true, "third ruleset strike aborts");
  });

  it("non-hazardous deny: nudge-and-continue until the strike budget is exhausted", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });
    const opts = {
      permission: "bash" as const,
      target: "curl http://example.com",
      check: { action: "deny" as const, reason: "Project policy: no network" },
      recheck: () => ({ action: "deny" as const }),
    };

    const first = await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, false, "first strike must not abort");
    assert.equal(first?.block, true);
    assert.equal(denials.filter(([, m]) => m === "visible").length, 0, "no visible entry before the aborting strike");

    await resolvePermission(deps, opts);
    await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, true, "third strike aborts when continue:false");
    assert.equal(denials.filter(([, m]) => m === "visible").length, 1, "only the aborting strike is visible");
  });
});

// ─── Headless deny ──────────────────────────────────────────────────────────

describe("resolvePermission — headless deny", () => {
  it("nudges-and-continues until the strike budget, then aborts when !continue", async () => {
    const ctx = makeCtx({ hasUI: false });
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });
    const opts = { permission: "bash" as const, target: "curl http://example.com", check: ASK_CHECK, recheck: ASK_RECHECK };

    const first = await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, false, "first headless deny must not abort");
    assert.equal(first?.block, true);

    await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, false, "second headless deny must not abort");

    const third = await resolvePermission(deps, opts);
    const line = denialMessage("bash", "curl http://example.com", "Bash requires approval (headless mode)", "headless");
    assert.equal(ctx.aborted.value, true, "third headless deny aborts when !continue");
    assert.equal(third?.reason, line);

    assert.equal(denials.filter(([, m]) => m === "hidden").length, 3, "every strike gets a hidden nudge");
    assert.deepEqual(denials.filter(([, m]) => m === "visible"), [[line, "visible"]]);
  });
});

// ─── Unified strike budget (autoDeny.maxStrikes) ────────────────────────────

describe("resolvePermission — autoDeny.maxStrikes", () => {
  const denyOpts = () => ({
    permission: "bash" as const,
    target: "curl http://example.com",
    check: { action: "deny" as const, reason: "Project policy: no network" },
    recheck: () => ({ action: "deny" as const }),
  });

  it("maxStrikes:1 aborts on the first strike", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: false, maxStrikes: 1 },
        hazardousDenyState: { count: 0 },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      denyOpts(),
    );
    const line = denialMessage("bash", "curl http://example.com", "Project policy: no network", "ruleset");
    assert.equal(ctx.aborted.value, true, "maxStrikes:1 aborts immediately");
    assert.deepEqual(denials, [
      [line, "hidden"],
      [line, "visible"],
    ]);
    assert.equal(result?.reason, line);
  });

  it("maxStrikes:2 aborts on the second strike, not the first", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false, maxStrikes: 2 },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });

    await resolvePermission(deps, denyOpts());
    assert.equal(ctx.aborted.value, false, "first strike must not abort");
    await resolvePermission(deps, denyOpts());
    assert.equal(ctx.aborted.value, true, "second strike aborts");
    assert.equal(denials.filter(([, m]) => m === "visible").length, 1);
  });

  it("continue:true never aborts, even with maxStrikes:1", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: true, maxStrikes: 1 },
        hazardousDenyState: { count: 0 },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      denyOpts(),
    );
    const line = denialMessage("bash", "curl http://example.com", "Project policy: no network", "ruleset");
    assert.equal(ctx.aborted.value, false, "continue:true keeps the turn alive");
    assert.deepEqual(denials, [[line, "hidden"]]);
    assert.equal(result?.block, true);
  });
});

// ─── ro/rw mode enforcement: auto reviewer must reject writes in ro mode ────

// In a read-only session (plan/ro), the auto reviewer must never approve a
// write. Mechanically-classifiable writes (edit tool, bash output redirects)
// are denied outright before the reviewer runs — a reviewer hallucinate must
// not mint temp write rules in ro mode. Semantic writers (git commit, touch,
// mkdir) are covered by the reviewer prompt's Session-mode rule instead.

describe("resolvePermission — auto reviewer honors read-only mode", () => {
  it("denies an edit/write tool call in ro mode without invoking the reviewer", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const storage = makeStorage();
    const denials: Array<[string, string]> = [];
    let spawnCalls = 0;
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        storage,
        cwd: "/tmp/ro-proj",
        allowModes: ["plan", "build"], // read-only session (plan-build paradigm)
        autoDeny: { continue: true },   // keep the turn alive for assertions
        sendDenial: (t: string, m: string) => denials.push([t, m]),
        reviewSpawn: async () => { spawnCalls++; return allowAssessment(); },
      }),
      {
        permission: "edit",
        target: "/tmp/ro-proj/package.json",
        check: ASK_CHECK,
        recheck: ASK_RECHECK,
      },
    );

    assert.equal(spawnCalls, 0, "reviewer must not run for a write in ro mode");
    assert.equal(ctx.aborted.value, false, "autoDeny.continue keeps the turn alive");
    assert.equal(denials.length, 1, "single hidden nudge");
    assert.equal(denials[0]![1], "hidden");
    assert.match(denials[0]![0], /Mode denied edit:/, "labelled as mode-enforced");
    assert.match(denials[0]![0], /read-only mode prevents writes/, "states the mode rule");
    assert.ok(result, "blocked");
    assert.equal(result!.block, true);
    assert.equal(storage.temp.getRules().length, 0, "no temp allow rules minted in ro mode");
  });

  it("denies bash with an output redirect in ro mode without invoking the reviewer", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    let spawnCalls = 0;
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        cwd: "/tmp/ro-proj",
        allowModes: ["ro", "rw"], // read-only session (ro-rw paradigm)
        autoDeny: { continue: true },
        sendDenial: () => {},
        reviewSpawn: async () => { spawnCalls++; return allowAssessment(); },
      }),
      {
        permission: "bash",
        target: "echo hi > notes.txt",
        check: { action: "ask", redirectTargets: [{ permission: "edit", path: "/tmp/ro-proj/notes.txt" }] },
        recheck: ASK_RECHECK,
      },
    );
    assert.equal(spawnCalls, 0, "reviewer must not run for a write in ro mode");
    assert.ok(result);
    assert.match(result!.reason, /read-only mode prevents writes/);
  });

  it("read-only write denials nudge-and-continue until the strike budget, then abort", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      cwd: "/tmp/ro-proj",
      allowModes: ["ro", "rw"],
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
      reviewSpawn: async () => allowAssessment(),
    });
    const opts = {
      permission: "bash" as const,
      target: "echo hi > notes.txt",
      check: { action: "ask" as const, redirectTargets: [{ permission: "edit" as const, path: "/tmp/ro-proj/notes.txt" }] },
      recheck: ASK_RECHECK,
    };

    await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, false, "first read-only write denial must not abort");
    await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, false, "second read-only write denial must not abort");
    await resolvePermission(deps, opts);
    assert.equal(ctx.aborted.value, true, "third read-only write denial aborts");
    assert.ok(denials.every(([t]) => t.includes("Mode denied bash:")), "labelled mode-enforced");
    assert.equal(denials.filter(([, m]) => m === "visible").length, 1, "only the aborting strike is visible");
  });

  it("still routes pure reads through the reviewer in ro mode", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const storage = makeStorage();
    let spawnCalls = 0;
    const wrappedSpawn = async () => {
      spawnCalls++;
      return makeReviewSpawn([allowAssessment()])();
    };
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        storage,
        cwd: "/tmp/ro-proj",
        allowModes: ["plan", "build"],
        reviewSpawn: wrappedSpawn,
        sendAutoApproval: () => {},
      }),
      {
        permission: "read",
        target: "/tmp/ro-proj/src/x.ts",
        check: ASK_CHECK,
        recheck: () => ({ action: "allow" as const }),
      },
    );
    assert.equal(spawnCalls, 1, "reads are still auto-reviewable in ro mode");
    assert.equal(result, undefined, "read auto-approval proceeds");
  });
});

// ─── Regression: auto-approval must not abort the turn on write batches ─────
//
// Session 019fd4a1: with /safetynet:auto on, a batch of `write` tool calls
// (package.json, tsconfig.json, main.css, .gitignore) aborted with
// "Operation aborted" every time, even after removing .env.example. Two bugs:
//   1. buildApprovalRules created NO temp rule for a plain read/edit/write file
//      call (no subcommands, no redirects), so the reviewer's allow never
//      satisfied the post-allow recheck → transient → prompt+retry → abort.
//   2. When the background retry verdict arrived, the prompt dismissed with
//      null, and the null was treated as a user Esc-abort BEFORE the pending
//      auto result was consulted → ctx.abort() killed the whole turn.

function allowAssessment(rationale = "routinely reviewed low-risk file write") {
  return {
    kind: "assessment" as const,
    assessment: {
      risk_level: "low" as const,
      user_authorization: "high" as const,
      outcome: "allow" as const,
      rationale,
    },
  };
}

describe("buildApprovalRules — plain file target", () => {
  it("creates a temp rule for a read/edit/write call with no subcommands or redirects", () => {
    const rules = buildApprovalRules(
      { action: "ask" },
      "edit",
      "/tmp/proj",
      ["build"],
      "/tmp/proj/package.json",
    );
    assert.equal(rules.length, 1, "must emit exactly one file rule");
    assert.equal(rules[0]!.rule.permission, "edit");
    assert.equal(rules[0]!.rule.action, "allow");
    assert.ok(rules[0]!.rule.pattern.includes("package.json"), `pattern=${rules[0]!.rule.pattern}`);
    assert.equal(rules[0]!.expiry.type, "turn");
  });

  it("creates no extra file rule when unapproved subcommands already exist", () => {
    const rules = buildApprovalRules(
      { action: "ask", unapproved: ["bun install"] },
      "bash",
      "/tmp/proj",
      ["build"],
      "bun install",
    );
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.rule.pattern, "bun install");
  });
});

describe("resolvePermission — auto allow satisfies recheck for file write", () => {
  it("reviewer allow + recheck-now-allow returns undefined (proceeds) without aborting", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const fileTarget = "/tmp/regression-auto-allow/package.json";
    // recheck consults the storage that buildApprovalRules seeded via
    // addTempRules — exactly like the main-session storage wiring. cwd must
    // match deps.cwd so the temp rule normalizes to the same key the
    // recheck evaluates.
    const storage = makeStorage();
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        storage,
        cwd: "/tmp/regression-auto-allow",
        reviewSpawn: makeReviewSpawn([allowAssessment()]),
        sendAutoApproval: () => {},
      }),
      {
        permission: "edit",
        target: fileTarget,
        check: { action: "ask" },
        recheck: () => {
          return checkFileTarget(fileTarget, "edit", "build", storage.getAllRules(), "/tmp/regression-auto-allow");
        },
      },
    );
    assert.equal(ctx.aborted.value, false, "successful auto-approval must not abort");
    assert.equal(result, undefined, "allow must proceed (no block)");
    const rules = storage.temp.getRules();
    assert.equal(rules.length, 1, "temp rule created from reviewer allow");
  });
});

describe("resolvePermission — delayed pending auto verdict on null prompt", () => {
  it("processes pending allow before treating null as a user Esc-abort", async () => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    const ctx = makeCtx();
    const storage = makeStorage();

    // The real bug: with auto on, the first review attempt fails (infra
    // hiccup) so the pipeline falls to the interactive prompt while
    // background retries run. When a retry succeeds it stores the verdict
    // and aborts the prompt controller; the prompt resolves null. The old
    // code treated that null as a user Esc-abort and killed the turn.
    // Make the reviewer permanently transient so we control when the
    // verdict lands, then simulate a completed background retry.
    const transientSpawn = async () => ({ content: [], details: { error: "simulated infrastructure failure" } });
    let resolvePrompt: (v: null) => void = () => {};
    ctx.ui.custom = () => new Promise<null>((res) => { resolvePrompt = res; });
    ctx.ui.getToolsExpanded = () => true;

    const promise = resolvePermission(
      baseDeps({
        displayCtx: ctx,
        storage,
        cwd: "/tmp/regression-pending",
        reviewSpawn: transientSpawn,
        sendAutoApproval: () => {},
      }),
      {
        permission: "edit",
        target: "/tmp/regression-pending/package.json",
        check: { action: "ask" },
        recheck: () => {
          return checkFileTarget("/tmp/regression-pending/package.json", "edit", "build", storage.getAllRules(), "/tmp/regression-pending");
        },
      },
    );

    // Wait for the pipeline to reach the prompt, then deliver the verdict
    // the way the background retry would: store it, then dismiss the prompt.
    await new Promise((r) => setTimeout(r, 5));
    const { setPendingAutoResult } = await import("./core/reviewer-state.ts");
    setPendingAutoResult(allowAssessment());
    resolvePrompt(null);

    const result = await promise;
    assert.equal(ctx.aborted.value, false, "pending allow must not abort the turn");
    assert.equal(result, undefined, "pending allow must proceed (no block)");
  });
});
