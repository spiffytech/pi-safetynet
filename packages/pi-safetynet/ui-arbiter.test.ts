/**
 * ui-arbiter.test.ts — lock the coordination contract: P0 preempts P1,
 * P1 denied while busy, release is identity-guarded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { uiArbiter, type ArbiterEntry } from "./core/ui-arbiter.ts";

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

  it("P0 acquiring while P0 showing replaces cleanly", () => {
    const a = entry("p0");
    const b = entry("p0");
    assert.equal(uiArbiter.acquire(a), true);
    assert.equal(uiArbiter.acquire(b), true);
    uiArbiter.release(b);
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
