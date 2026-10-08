/**
 * ui-arbiter.test.ts — lock the coordination contract: P0 preempts P1, P1
 * denied while busy, a displaced gate is dismissed (never stranded), reset
 * dismisses whatever is showing, and release is identity-guarded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uiArbiter, createGateSettlement, type ArbiterEntry } from "./core/ui-arbiter.ts";

function entry(priority: "p0" | "p1", onDismiss?: () => void): ArbiterEntry {
  return { priority, dismiss: onDismiss ?? (() => {}) };
}

describe("ui arbiter", () => {
  it("P1 acquires when idle", () => {
    const e = entry("p1");
    assert.equal(uiArbiter.acquire(e), true);
    uiArbiter.release(e);
  });

  it("P1 is denied while another P1 shows", () => {
    const a = entry("p1");
    assert.equal(uiArbiter.acquire(a), true);
    assert.equal(uiArbiter.acquire(entry("p1")), false);
    uiArbiter.release(a);
  });

  it("P1 is denied while a P0 shows", () => {
    const p0 = entry("p0");
    assert.equal(uiArbiter.acquire(p0), true);
    assert.equal(uiArbiter.acquire(entry("p1")), false);
    uiArbiter.release(p0);
  });

  it("P0 preempts a showing P1 by dismissing it", () => {
    let dismissed = 0;
    const p1 = entry("p1", () => dismissed++);
    assert.equal(uiArbiter.acquire(p1), true);
    const p0 = entry("p0");
    assert.equal(uiArbiter.acquire(p0), true);
    assert.equal(dismissed, 1, "P1 was force-dismissed (defer, not abort)");
    // Late release from the preempted P1 must NOT clear the live P0.
    uiArbiter.release(p1);
    assert.equal(uiArbiter.isShowing(), true);
    uiArbiter.release(p0);
    assert.equal(uiArbiter.isShowing(), false);
  });

  it("P0 preempting a showing P0 dismisses the displaced one", () => {
    let dismissed = 0;
    const a = entry("p0", () => dismissed++);
    const b = entry("p0");
    assert.equal(uiArbiter.acquire(a), true);
    assert.equal(uiArbiter.acquire(b), true);
    assert.equal(dismissed, 1, "the displaced gate was dismissed, not stranded");
    // The displaced entry's late release must not clear the live one.
    uiArbiter.release(a);
    assert.equal(uiArbiter.isShowing(), true);
    uiArbiter.release(b);
    assert.equal(uiArbiter.isShowing(), false);
  });

  it("reset dismisses a showing P0 instead of leaving it pending", () => {
    let dismissed = 0;
    const p0 = entry("p0", () => dismissed++);
    assert.equal(uiArbiter.acquire(p0), true);
    uiArbiter.reset();
    assert.equal(dismissed, 1, "a pending gate must resolve, not await forever");
    assert.equal(uiArbiter.isShowing(), false);
  });

  it("release of a stale entry never clears the current one", () => {
    const ghost = entry("p1");
    uiArbiter.release(ghost); // never acquired
    const p0 = entry("p0");
    assert.equal(uiArbiter.acquire(p0), true);
    uiArbiter.release(ghost);
    assert.equal(uiArbiter.isShowing(), true);
    uiArbiter.release(p0);
  });
});

describe("gate settlement", () => {
  it("dismiss resolves the gate as a deny", () => {
    const gate = createGateSettlement<string>(() => "DENIED");
    const seen: string[] = [];
    gate.bind((r) => seen.push(r));
    gate.entry.dismiss();
    assert.deepEqual(seen, ["DENIED"]);
  });

  it("dismiss before the mount resolves as soon as done is bound", () => {
    const gate = createGateSettlement<string>(() => "DENIED");
    gate.entry.dismiss();
    const seen: string[] = [];
    gate.bind((r) => seen.push(r));
    assert.deepEqual(seen, ["DENIED"]);
  });

  it("settles exactly once — later finishes and dismisses are no-ops", () => {
    const gate = createGateSettlement<string>(() => "DENIED");
    const seen: string[] = [];
    gate.bind((r) => seen.push(r));
    gate.finish("APPROVED");
    gate.finish("APPROVED");
    gate.entry.dismiss();
    assert.deepEqual(seen, ["APPROVED"]);
  });

  it("a racing gate resolves the earlier one as a deny, not a stranded await", () => {
    const denials: string[] = [];
    const a = createGateSettlement<string>(() => "DENIED-A");
    a.bind((r) => denials.push(r));
    const b = createGateSettlement<string>(() => "DENIED-B");

    assert.equal(uiArbiter.acquire(a.entry), true);
    assert.equal(uiArbiter.acquire(b.entry), true); // preempts a
    assert.deepEqual(denials, ["DENIED-A"]);
    uiArbiter.release(a.entry); // late release must not clear b
    assert.equal(uiArbiter.isShowing(), true);
    uiArbiter.release(b.entry);
    assert.equal(uiArbiter.isShowing(), false);
  });
});
