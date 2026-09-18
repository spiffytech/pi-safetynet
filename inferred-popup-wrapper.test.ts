/**
 * inferred-popup-wrapper.test.ts — wrapper-level contract.
 *
 * Covers the two failure modes found in the harness:
 *  - "two pending proposals, slash command does nothing": a second custom()
 *    while our popup is mounted must never be issued (arbiter pre-check).
 *  - "session hangs on the offer prompt": popups are now OVERLAYS (immune to
 *    editorContainer.clear() eviction) and fire-and-forget (the returned
 *    promise never waits on the user), so no caller can hang.
 *
 * Uses the pi wrapper (earendil pi-tui loads under Node; the omp wrapper's
 * @oh-my-pi/pi-tui only evaluates under Bun).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferredEngine } from "./core/inferred/engine.ts";
import { uiArbiter } from "./core/ui-arbiter.ts";
import { openInferredReview } from "./inferred-popup-pi.ts";
import { resetLearnedBoundariesForTests } from "./core/inferred/shapes.ts";

// Hermetic global store: never read/write the user's real ~/.config/pi-safetynet.
process.env.SAFETYNET_INFERRED_DIR = mkdtempSync(join(tmpdir(), "safetynet-global-"));

async function makeEngine(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "safetynet-wrap-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const engine = new InferredEngine(dir);
  engine.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
  const shapes = [["git log main", "git log dev"], ["dd if=a.img bs=4M", "dd if=b.iso bs=1M"]];
  for (let i = 0; i < count; i++) for (const c of shapes[i % shapes.length]!) engine.recordApproval(c, ["build"]);
  await new Promise((r) => setTimeout(r, 10));
  return engine;
}

interface Call {
  overlay?: boolean;
  component?: { dispose?: () => void };
  hidden: boolean;
  settled: boolean;
}

/** Fake ctx capturing custom() invocations, options, and overlay handles. */
function fakeCtx() {
  const calls: Call[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => {},
      setWidget: () => {},
      custom: async (factory: any, options?: any) => {
        const rec: Call = { overlay: options?.overlay, hidden: false, settled: false };
        calls.push(rec);
        const component = factory(
          { requestRender: () => {} },
          { fg: (_c: string, t: string) => t, bold: (t: string) => t },
          {},
          () => {
            rec.settled = true;
          },
        );
        rec.component = component;
        options?.onHandle?.({ hide: () => { rec.hidden = true; } });
        return component;
      },
    },
  };
  return { ctx: ctx as any, calls };
}

describe("inferred popup wrapper", () => {
  beforeEach(() => {
    resetLearnedBoundariesForTests();
    uiArbiter.reset();
  });

  it("returns empty without opening when nothing is pending", async () => {
    const engine = await makeEngine(0);
    const { ctx, calls } = fakeCtx();
    assert.equal(await openInferredReview(ctx, engine), "empty");
    assert.equal(calls.length, 0);
  });

  it("opens as an overlay and returns before the user is done", async () => {
    const engine = await makeEngine(2);
    const { ctx, calls } = fakeCtx();
    assert.equal(await openInferredReview(ctx, engine), "opened");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.overlay, true, "must render as an overlay, not an editor replacement");
    assert.equal(uiArbiter.isShowing(), true, "overlay mounted");
    assert.equal(engine.listProposals().length, 2, "queue intact — nobody waited on the user");
  });

  it("refuses to open while another surface is mounted (no custom call)", async () => {
    const engine = await makeEngine(2);
    const { ctx, calls } = fakeCtx();
    const p0 = { priority: "p0" as const, dismiss: () => {} };
    assert.equal(uiArbiter.acquire(p0), true);
    assert.equal(await openInferredReview(ctx, engine), "busy");
    assert.equal(calls.length, 0, "custom() must not be invoked over a live prompt");
    uiArbiter.release(p0);
  });

  it("P0 preemption hides the overlay and releases the arbiter", async () => {
    const engine = await makeEngine(2);
    const { ctx, calls } = fakeCtx();
    assert.equal(await openInferredReview(ctx, engine), "opened");
    assert.equal(calls[0]!.hidden, false);

    // A permission prompt arrives while the offer is up.
    const p0 = { priority: "p0" as const, dismiss: () => {} };
    assert.equal(uiArbiter.acquire(p0), true);

    assert.equal(calls[0]!.hidden, true, "preempted overlay was hidden via its handle");
    assert.equal(calls[0]!.settled, true, "orphaned promise settled (no stranded await)");
    assert.equal(uiArbiter.isShowing(), true, "P0 now holds the arbiter");
    uiArbiter.release(p0);
  });

  it("releases the arbiter when the harness disposes the component", async () => {
    const engine = await makeEngine(2);
    const { ctx, calls } = fakeCtx();
    assert.equal(await openInferredReview(ctx, engine), "opened");
    assert.equal(uiArbiter.isShowing(), true);
    calls[0]!.component!.dispose!();
    assert.equal(uiArbiter.isShowing(), false, "arbiter freed after teardown");
    assert.equal(calls[0]!.hidden, true, "overlay hidden on teardown");
    assert.equal(await openInferredReview(ctx, engine), "opened", "a second popup can now open");
  });

  it("releases the arbiter if custom() rejects (abort)", async () => {
    const engine = await makeEngine(2);
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        setWidget: () => {},
        custom: async () => {
          throw new Error("aborted");
        },
      },
    } as any;
    assert.equal(await openInferredReview(ctx, engine), "opened");
    await new Promise((r) => setTimeout(r, 5)); // let the rejection handler run
    assert.equal(uiArbiter.isShowing(), false, "abort must not leak the arbiter");
  });

  it("a second open while the first is showing is refused, not stacked", async () => {
    const engine = await makeEngine(2);
    const { ctx, calls } = fakeCtx();
    assert.equal(await openInferredReview(ctx, engine), "opened");
    assert.equal(await openInferredReview(ctx, engine), "busy");
    assert.equal(calls.length, 1, "no second custom() invocation");
  });
});

describe("arbiter reset (session teardown)", () => {
  beforeEach(() => uiArbiter.reset());

  it("dismisses a showing P1 so it cannot block the next session", () => {
    let dismissed = 0;
    const p1 = { priority: "p1" as const, dismiss: () => dismissed++ };
    assert.equal(uiArbiter.acquire(p1), true);
    uiArbiter.reset();
    assert.equal(dismissed, 1, "P1 is defer-dismissed (hide, never abort)");
    assert.equal(uiArbiter.isShowing(), false);
  });

  it("never dismisses a P0 gating prompt (that would deny a tool call)", () => {
    let dismissed = 0;
    const p0 = { priority: "p0" as const, dismiss: () => dismissed++ };
    assert.equal(uiArbiter.acquire(p0), true);
    uiArbiter.reset();
    assert.equal(dismissed, 0, "P0 must survive a reset");
    assert.equal(uiArbiter.isShowing(), false, "but the stale slot is cleared");
  });
});