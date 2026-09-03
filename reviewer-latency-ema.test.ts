/**
 * Reviewer latency EMA tracking — the sticky slow-reviewer warning input.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  reviewRecordLatency,
  reviewLatencyEma,
  resetReviewStateForTests,
} from "./core/reviewer-state.ts";

test("EMA is null before any sample", () => {
  resetReviewStateForTests();
  assert.equal(reviewLatencyEma(), null);
});

test("first sample seeds the EMA directly", () => {
  resetReviewStateForTests();
  assert.equal(reviewRecordLatency(1200), 1200);
  assert.equal(reviewLatencyEma(), 1200);
});

test("EMA blends subsequent samples at alpha 0.3", () => {
  resetReviewStateForTests();
  reviewRecordLatency(1000);
  // 1000*0.7 + 2000*0.3 = 1300
  assert.equal(reviewRecordLatency(2000), 1300);
  // 1300*0.7 + 900*0.3 = 1180
  assert.equal(reviewRecordLatency(900), 1180);
});

test("reset clears the EMA", () => {
  resetReviewStateForTests();
  reviewRecordLatency(5000);
  resetReviewStateForTests();
  assert.equal(reviewLatencyEma(), null);
});
