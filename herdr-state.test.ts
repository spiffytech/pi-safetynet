import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolvePermission } from "./pipeline.ts";
import { bindHerdrBlockedEmitter, reportBlocked } from "./herdr-state.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─── Test scaffolding ──────────────────────────────────────────────────────
//
// The pipeline reads review config from ~/.config/pi-safetynet/config.json via
// os.homedir(). We point HOME at a temp dir so auto-approve stays off.

const TMP_HOME = join(process.cwd(), ".test-tmp-home-herdr");
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
  bindHerdrBlockedEmitter(recordBlocked);
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  bindHerdrBlockedEmitter();
  spy.events.length = 0;
});

/** Records (active, label?) pairs received by the herdr emitter. */
const spy: { events: Array<{ active: boolean; label?: string | undefined }> } = { events: [] };
function recordBlocked(active: boolean, label?: string) {
  spy.events.push(active ? { active, label: label ?? undefined } : { active });
}

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
      custom: async () => null,
    },
    abort() { aborted.value = true; },
    sessionManager: { getEntries: () => [] },
    ...overrides,
  };
}

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

const ASK_CHECK = { action: "ask" as const };
const ASK_RECHECK = () => ({ action: "ask" as const });

/** Approve-with-once-duration result (no rules created, resolution completes). */
function approveOnce() {
  return {
    kind: "approve" as const,
    approved: new Map<string, string>(),
    skipped: [] as string[],
    skippedDisplay: [] as string[],
    duration: "once" as const,
  };
}

/** Dismiss-with-null = user Esc → deny-abort. */
function dismiss() {
  return null;
}

// ─── herdr-state (pure emitter) ─────────────────────────────────────────────

describe("reportBlocked", () => {
  it("delivers to the bound emitter", () => {
    bindHerdrBlockedEmitter(recordBlocked);
    reportBlocked(true, "npm install");
    reportBlocked(false);
    assert.deepEqual(spy.events, [
      { active: true, label: "npm install" },
      { active: false },
    ]);
  });

  it("is a no-op with no emitter bound", () => {
    bindHerdrBlockedEmitter();
    assert.doesNotThrow(() => reportBlocked(true, "x"));
    assert.equal(spy.events.length, 0);
  });

  it("never throws when the emitter throws", () => {
    bindHerdrBlockedEmitter(() => { throw new Error("downstream boom"); });
    assert.doesNotThrow(() => reportBlocked(true, "x"));
  });
});

// ─── resolvePermission — herdr blocked signal ───────────────────────────────

describe("resolvePermission — herdr blocked signal", () => {
  it("emits blocked(true) before the prompt and blocked(false) after approve", async () => {
    const ctx = makeCtx();
    let resolvePrompt: (v: any) => void = () => {};
    ctx.ui.custom = () => new Promise<any>((res) => { resolvePrompt = res; });

    const promise = resolvePermission(
      baseDeps({ displayCtx: ctx }),
      { permission: "bash", target: "npm install -g foo", check: ASK_CHECK, recheck: ASK_RECHECK },
    );

    // Let the pipeline reach the prompt (the emit happens synchronously before
    // showPermissionPrompt awaits, so it must already be recorded).
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(spy.events, [{ active: true, label: "npm install -g foo" }]);

    resolvePrompt(approveOnce());
    await promise;
    assert.equal(spy.events[spy.events.length - 1]!.active, false, "must clear after resolution");
  });

  it("clears blocked(false) on a deny-abort (null prompt / Esc)", async () => {
    const ctx = makeCtx();
    let resolvePrompt: (v: any) => void = () => {};
    ctx.ui.custom = () => new Promise<any>((res) => { resolvePrompt = res; });

    const promise = resolvePermission(
      baseDeps({ displayCtx: ctx }),
      { permission: "bash", target: "rm -rf /tmp/data", check: ASK_CHECK, recheck: ASK_RECHECK },
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(spy.events[0]!.active, true);

    resolvePrompt(dismiss());
    await promise;
    assert.equal(spy.events[spy.events.length - 1]!.active, false, "must clear on deny-abort");
  });

  it("keeps blocked(true) across a reprompt (approve-insufficient-rules → continue)", async () => {
    const ctx = makeCtx();
    let resolvePrompt: (v: any) => void = () => {};
    ctx.ui.custom = () => new Promise<any>((res) => { resolvePrompt = res; });

    // First approve (session-duration) adds rules, but the recheck still says
    // "ask" → reprompt = true → second prompt. Only the second approve (once)
    // completes the resolution.
    const recheckResponses = [{ action: "ask" }, { action: "ask" }];
    let recheckI = 0;
    const recheck = () => recheckResponses[Math.min(recheckI++, recheckResponses.length - 1)] as any;

    const promise = resolvePermission(
      baseDeps({ displayCtx: ctx }),
      { permission: "edit", target: "/tmp/proj/package.json", check: ASK_CHECK, recheck },
    );

    await new Promise((r) => setTimeout(r, 5));
    assert.equal(spy.events[0]!.active, true, "blocked at first prompt");

    // Session-duration approve → rules added → recheck ask → reprompt.
    resolvePrompt({
      kind: "approve",
      approved: new Map([["/tmp/proj/package.json", "/tmp/proj/package.json"]]),
      skipped: [],
      skippedDisplay: [],
      duration: "session",
    });
    await new Promise((r) => setTimeout(r, 5));

    // No clear emitted and no second blocked() — the signal stays active across reprompts.
    const midEvents = spy.events.map((e) => e.active);
    assert.ok(midEvents.every((a) => a === true), `all events active during reprompt: ${JSON.stringify(midEvents)}`);

    resolvePrompt(approveOnce());
    await promise;
    assert.equal(spy.events[spy.events.length - 1]!.active, false, "must clear after final resolution");
  });

  it("does not emit blocked when the check short-circuits to allow", async () => {
    const ctx = makeCtx();
    await resolvePermission(
      baseDeps({ displayCtx: ctx }),
      { permission: "read", target: "/tmp/proj/README.md", check: { action: "allow" }, recheck: ASK_RECHECK },
    );
    assert.equal(spy.events.length, 0, "allow must not touch the herdr signal");
  });

  it("does not emit blocked when the check short-circuits to deny", async () => {
    const ctx = makeCtx();
    await resolvePermission(
      baseDeps({ displayCtx: ctx }),
      {
        permission: "read",
        target: "/etc/passwd",
        check: { action: "deny", reason: "Hazardous file" },
        recheck: ASK_RECHECK,
      },
    );
    assert.equal(spy.events.length, 0, "deny must not emit blocked");
  });

  it("emits blocked even when a reviewSpawn is configured but auto mode is off", async () => {
    // Auto-review is disabled in these tests, so reviewSpawn is never invoked;
    // the ask check falls straight to the interactive prompt, which must still
    // signal blocked while it waits.
    const ctx = makeCtx();
    let resolvePrompt: (v: any) => void = () => {};
    ctx.ui.custom = () => new Promise<any>((res) => { resolvePrompt = res; });

    const promise = resolvePermission(
      baseDeps({ displayCtx: ctx, reviewSpawn: async () => ({ content: [], details: { error: "infra" } }) }),
      { permission: "bash", target: "echo hi", check: ASK_CHECK, recheck: ASK_RECHECK },
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(spy.events[0]!.active, true, "transient review → prompt must still block");
    resolvePrompt(approveOnce());
    await promise;
    assert.equal(spy.events[spy.events.length - 1]!.active, false);
  });
});
