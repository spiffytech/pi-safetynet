import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolvePermission, denialDetail, buildApprovalRules } from "./pipeline.ts";
import { checkFileTarget } from "./core/check.ts";
import { setAutoEnabled } from "./auto-config.ts";
import { resetReviewStateForTests } from "./reviewer.ts";
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
      ["Auto-denied bash: rm -rf /tmp/data — destructive and not user-authorized", "hidden"],
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

// ─── Ruleset denials (deny rules) ───────────────────────────────────────────

describe("resolvePermission — deny rule", () => {
  it("continue:false — visible entry before abort, hidden nudge, enriched reason", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: false },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      {
        permission: "read",
        target: "/etc/passwd",
        check: { action: "deny" as const, reason: "Hazardous file" },
        recheck: () => ({ action: "deny" as const }),
      },
    );

    assert.equal(ctx.aborted.value, true, "continue:false aborts");
    assert.deepEqual(denials, [
      ["Ruleset denied read: /etc/passwd — Hazardous file", "hidden"],
      ["Ruleset denied read: /etc/passwd — Hazardous file", "visible"],
    ]);
    assert.equal(result?.reason, "Ruleset denied read: /etc/passwd — Hazardous file");
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

    assert.equal(ctx.aborted.value, false, "continue:true keeps the turn alive");
    assert.deepEqual(denials, [
      ["Ruleset denied bash: curl http://example.com — Project policy: no network", "hidden"],
    ]);
    assert.equal(result?.reason, "Ruleset denied bash: curl http://example.com — Project policy: no network");
  });
});

// ─── Hazardous-file denials (nudge-and-continue, bounded) ──────────────────

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

    assert.equal(ctx.aborted.value, false, "1st hazardous deny must NOT abort");
    assert.deepEqual(denials, [
      ["Ruleset denied read: /etc/passwd — Sensitive file", "hidden"],
    ]);
    assert.equal(result?.reason, "Ruleset denied read: /etc/passwd — Sensitive file");
  });

  it("2nd hazardous deny: still no abort", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });

    await resolvePermission(deps, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });
    const result = await resolvePermission(deps, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });

    assert.equal(ctx.aborted.value, false, "2nd hazardous deny must NOT abort");
    assert.equal(denials.length, 2, "two hidden nudges");
    assert.ok(denials.every(([, m]) => m === "hidden"));
    assert.equal(result?.block, true);
  });

  it("3rd hazardous deny: visible entry + abort (cap reached)", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const deps = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      hazardousDenyState: { count: 0 },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
    });

    for (let i = 0; i < 3; i++) {
      await resolvePermission(deps, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });
    }

    assert.equal(ctx.aborted.value, true, "3rd hazardous deny aborts the turn");
    const hidden = denials.filter(([, m]) => m === "hidden");
    const visible = denials.filter(([, m]) => m === "visible");
    assert.equal(hidden.length, 3, "every strike gets a hidden nudge");
    assert.equal(visible.length, 1, "only the aborting strike gets a visible entry");
  });

  it("hazardous cap is per-scope: separate state does not share counts", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const depsA = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
      hazardousDenyState: { count: 0 },
    });
    const depsB = baseDeps({
      displayCtx: ctx,
      autoDeny: { continue: false },
      sendDenial: (t: string, m: string) => denials.push([t, m]),
      hazardousDenyState: { count: 0 },
    });

    // Two strikes in scope A, then two in scope B — neither reaches 3.
    for (let i = 0; i < 2; i++) {
      await resolvePermission(depsA, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });
    }
    for (let i = 0; i < 2; i++) {
      await resolvePermission(depsB, { permission: "read", target: "/etc/passwd", check: HAZ_CHECK, recheck: () => HAZ_CHECK });
    }

    assert.equal(ctx.aborted.value, false, "parallel scopes must not share the cap");
  });

  it("non-hazardous deny still aborts immediately when continue:false", async () => {
    const ctx = makeCtx();
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: false },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      {
        permission: "bash",
        target: "curl http://example.com",
        check: { action: "deny" as const, reason: "Project policy: no network" },
        recheck: () => ({ action: "deny" as const }),
      },
    );

    assert.equal(ctx.aborted.value, true, "non-hazardous deny aborts when continue:false");
    assert.equal(result?.block, true);
  });
});

// ─── Headless deny ──────────────────────────────────────────────────────────

describe("resolvePermission — headless deny", () => {
  it("hidden nudge only (no UI to show visible), still aborts when !continue", async () => {
    const ctx = makeCtx({ hasUI: false });
    const denials: Array<[string, string]> = [];
    const result = await resolvePermission(
      baseDeps({
        displayCtx: ctx,
        autoDeny: { continue: false },
        sendDenial: (t: string, m: string) => denials.push([t, m]),
      }),
      { permission: "bash", target: "curl http://example.com", check: ASK_CHECK, recheck: ASK_RECHECK },
    );

    assert.equal(ctx.aborted.value, true, "headless deny aborts when !continue");
    assert.deepEqual(denials, [
      ["Denied bash: curl http://example.com — Bash requires approval (headless mode)", "hidden"],
    ]);
    assert.equal(result?.block, true);
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
    const { setPendingAutoResult } = await import("./reviewer.ts");
    setPendingAutoResult(allowAssessment());
    resolvePrompt(null);

    const result = await promise;
    assert.equal(ctx.aborted.value, false, "pending allow must not abort the turn");
    assert.equal(result, undefined, "pending allow must proceed (no block)");
  });
});
