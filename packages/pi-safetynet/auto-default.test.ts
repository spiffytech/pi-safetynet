import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hasReviewerModel, resetAutoEnabledForNewSession, isAutoEnabled, toggleAutoEnabled } from "./core/auto-config-state.ts";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Auto-approve defaults derive from ~/.config/pi-safetynet/config.json via
// os.homedir(). Point HOME at a temp dir to control the config.

const TMP_HOME = join(process.cwd(), ".test-tmp-home-auto-default");
const originalHome = process.env.HOME;

function writeConfig(autoApprove: unknown): void {
  writeFileSync(
    join(TMP_HOME, ".config", "pi-safetynet", "config.json"),
    JSON.stringify({ autoApprove }),
    "utf-8",
  );
}

beforeEach(() => {
  process.env.HOME = TMP_HOME;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
});

describe("auto-approve config-gated default", () => {
  it("hasReviewerModel is false without autoApprove.model", () => {
    writeConfig({ timeoutMs: 5000 });
    assert.equal(hasReviewerModel(), false);
    resetAutoEnabledForNewSession();
    assert.equal(isAutoEnabled(), false, "default must be OFF without a reviewer model");
  });

  it("hasReviewerModel is true with autoApprove.model", () => {
    writeConfig({ model: "provider/model-id" });
    assert.equal(hasReviewerModel(), true);
    resetAutoEnabledForNewSession();
    assert.equal(isAutoEnabled(), true, "default must be ON with a reviewer model");
  });

  it("hasReviewerModel is false with an empty model spec array", () => {
    writeConfig({ model: ["  ", ""] });
    assert.equal(hasReviewerModel(), false);
    resetAutoEnabledForNewSession();
    assert.equal(isAutoEnabled(), false);
  });

  it("toggle off→on is blocked without a reviewer model, with a reason", () => {
    writeConfig({ timeoutMs: 5000 });
    resetAutoEnabledForNewSession();
    assert.equal(isAutoEnabled(), false);
    const pi = { appendEntry: () => {} };
    const r = toggleAutoEnabled(pi as never);
    assert.ok(r.blockedReason, "must report why the toggle was blocked");
    assert.match(r.blockedReason, /autoApprove\.model/);
    assert.equal(r.enabled, false);
    assert.equal(isAutoEnabled(), false, "state must stay off");
  });

  it("toggle off→on works with a reviewer model", () => {
    writeConfig({ model: "provider/model-id" });
    resetAutoEnabledForNewSession();
    assert.equal(isAutoEnabled(), true);
    const pi = { appendEntry: () => {} };
    const r = toggleAutoEnabled(pi as never);
    assert.equal(r.blockedReason, undefined);
    assert.equal(r.enabled, false, "toggle flips on→off");
    assert.equal(isAutoEnabled(), false);
  });
});
