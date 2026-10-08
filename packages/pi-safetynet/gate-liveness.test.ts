/**
 * gate-liveness.test.ts — a gating prompt whose overlay has been popped must
 * report itself lost (so the caller can deny) rather than await forever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { watchGateLiveness, type BoundsProbe } from "./core/gate-liveness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probe(bounds: { height: number } | undefined): BoundsProbe {
  return { getBounds: () => bounds };
}

describe("gate liveness", () => {
  it("does not fire while the overlay is mounted and idle", async () => {
    let lost = 0;
    const stop = watchGateLiveness(probe({ height: 12 }), () => lost++, {
      graceMs: 2,
      intervalMs: 2,
    });
    await sleep(20);
    stop();
    assert.equal(lost, 0, "a mounted prompt waiting on the user is not a lost one");
  });

  it("fires once the overlay leaves the stack", async () => {
    let bounds: { height: number } | undefined = { height: 12 };
    let lost = 0;
    const stop = watchGateLiveness({ getBounds: () => bounds }, () => lost++, {
      graceMs: 2,
      intervalMs: 2,
      misses: 2,
    });
    await sleep(10);
    assert.equal(lost, 0);
    bounds = undefined; // popped by the harness
    await sleep(30);
    assert.equal(lost, 1);
    await sleep(20);
    assert.equal(lost, 1, "reports at most once");
    stop();
  });

  it("clears the miss counter when the overlay is seen again", async () => {
    const readings: Array<{ height: number } | undefined> = [{ height: 1 }, undefined];
    let i = 0;
    let lost = 0;
    const stop = watchGateLiveness(
      { getBounds: () => readings[i++ % readings.length] },
      () => lost++,
      { graceMs: 2, intervalMs: 2, misses: 2 },
    );
    await sleep(30);
    stop();
    assert.equal(lost, 0, "alternating readings must never accumulate into a loss");
  });

  it("stop() prevents a pending report", async () => {
    let bounds: { height: number } | undefined = { height: 1 };
    let lost = 0;
    const stop = watchGateLiveness({ getBounds: () => bounds }, () => lost++, {
      graceMs: 2,
      intervalMs: 2,
    });
    stop();
    bounds = undefined;
    await sleep(20);
    assert.equal(lost, 0);
  });
});
