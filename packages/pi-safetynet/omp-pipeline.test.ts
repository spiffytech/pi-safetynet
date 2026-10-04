import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resolveOmpPermission } from "./omp-pipeline.ts";
import { setAutoEnabled } from "./core/auto-config-state.ts";
import { resetReviewStateForTests } from "./core/reviewer-state.ts";

/**
 * omp-pipeline regression tests. The omp-only SDK imports (omp-permission-prompt,
 * omp-subagent) are now resolved lazily inside the two places that need them, so
 * this module loads under plain Node and the standard test suite can cover its
 * reviewer paths.
 *
 * Two post-audit behaviors are pinned here:
 *   1. the decision-time mode-flip guard on the auto-review allow path — a
 *      verdict minted under rw must not execute after the session flips to ro;
 *   2. the `maxDenials` circuit breaker actually aborts the turn (it claimed to
 *      "disable auto-approve" and did nothing before).
 */

function makeCtx() {
  const aborted = { value: false };
  return {
    aborted,
    hasUI: true,
    cwd: "/tmp",
    sessionManager: { getEntries: () => [] },
    ui: {
      notify: () => {},
      setWidget: () => {},
    },
    abort() {
      aborted.value = true;
    },
  };
}

function makeStorage() {
  const temp: { rules: any[] } = { rules: [] };
  return {
    temp,
    addTempRules(rules: any[]) {
      temp.rules.push(...rules);
    },
    addSessionRules() {},
    async addPersistedRules() {},
    async addGlobalRules() {},
  } as any;
}

/** Fake reviewer: returns canned assessments as the verdict tool arguments. */
function spawnWith(verdicts: Array<Record<string, string>>) {
  let i = 0;
  return async () => ({
    content: [{ type: "text", text: "" }],
    details: { verdict: verdicts[Math.min(i++, verdicts.length - 1)] },
  });
}

const ALLOW = { risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "verified safe" };
const DENY = { risk_level: "critical", user_authorization: "unknown", outcome: "deny", rationale: "destructive and unauthorised" };

function deps(ctx: ReturnType<typeof makeCtx>, storage: any, profile: "build" | "ro", currentProfile: "build" | "ro", verdicts: typeof ALLOW[]) {
  return {
    ctx,
    storage,
    profile,
    currentProfile: () => currentProfile,
    trustExternalPaths: false,
    modeAliases: {},
    reviewSpawn: spawnWith(verdicts),
  } as any;
}

const opts = (target = "touch x") => ({
  permission: "bash" as const,
  target,
  check: { action: "ask" as const, unapproved: [target] },
  recheck: () => ({ action: "allow" as const }),
});

describe("omp-pipeline reviewed actions", () => {
  beforeEach(() => {
    setAutoEnabled(true, { appendEntry: () => {} } as any);
    resetReviewStateForTests();
  });

  it("blocks an approval taken under rw once the session has flipped to ro", async () => {
    const ctx = makeCtx();
    const storage = makeStorage();
    const result = await resolveOmpPermission(
      deps(ctx, storage, "build", "ro", [ALLOW]),
      opts("touch x"),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /read-only/);
    assert.equal(storage.temp.rules.length, 0, "no rule is minted from a stale approval");
    assert.equal(ctx.aborted.value, false);
  });

  it("allows and mints a turn-scoped rule when no flip occurred", async () => {
    const ctx = makeCtx();
    const storage = makeStorage();
    const result = await resolveOmpPermission(
      deps(ctx, storage, "build", "build", [ALLOW]),
      opts("touch x"),
    );
    assert.equal(result, undefined, "reviewer allow passes when the mode is unchanged");
    assert.equal(storage.temp.rules.length, 1, "approval is recorded as a turn-scoped rule");
    assert.equal(ctx.aborted.value, false);
  });

  it("aborts the turn on the maxDenials-th consecutive reviewer denial", async () => {
    const ctx = makeCtx();
    const storage = makeStorage();
    const make = () => resolveOmpPermission(deps(ctx, storage, "build", "build", [DENY]), opts("rm x"));

    const first = await make();
    assert.equal(first?.block, true);
    assert.equal(ctx.aborted.value, false, "a single denial does not end the turn");
    assert.doesNotMatch(first?.reason ?? "", /ending the turn/);

    const second = await make();
    assert.equal(second?.block, true);
    assert.equal(ctx.aborted.value, false);

    const third = await make();
    assert.equal(third?.block, true);
    assert.equal(ctx.aborted.value, true, "the third consecutive denial aborts the turn");
    assert.match(third?.reason ?? "", /ending the turn/);
  });
});