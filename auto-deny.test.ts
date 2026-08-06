import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolvePermission, denialDetail } from "./pipeline.ts";
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
    ui: { notify: (m: string) => notifies.push(m) },
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
