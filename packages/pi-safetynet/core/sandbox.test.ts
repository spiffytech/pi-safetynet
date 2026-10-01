import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSandboxDir,
  ensureSandboxDir,
  getSandboxDir,
  isWithinSandbox,
  resolveAbsolute,
  setSandboxDir,
} from "./sandbox.ts";

const CWD = "/home/user/project";

describe("sandbox path construction", () => {
  it("names the directory after the session under the pi-safetynet base", () => {
    assert.equal(
      computeSandboxDir("01a0f506-65c7-7522-952e-d0fd231a0933"),
      join(tmpdir(), "pi-safetynet", "01a0f506-65c7-7522-952e-d0fd231a0933"),
    );
  });

  it("sanitizes path separators and traversal characters", () => {
    assert.equal(computeSandboxDir("../../etc/passwd"), join(tmpdir(), "pi-safetynet", ".._.._etc_passwd"));
  });

  it("falls back to a literal name for an empty id", () => {
    assert.equal(computeSandboxDir(""), join(tmpdir(), "pi-safetynet", "session"));
  });

  it("never resolves the base directory itself via dot-only ids", () => {
    assert.equal(computeSandboxDir("."), join(tmpdir(), "pi-safetynet", "_"));
    assert.equal(computeSandboxDir(".."), join(tmpdir(), "pi-safetynet", "_"));
  });
});

describe("isWithinSandbox", () => {
  const SANDBOX = "/tmp/pi-safetynet/abc";
  beforeEach(() => setSandboxDir(SANDBOX));
  afterEach(() => setSandboxDir(undefined));

  it("returns false when no sandbox is active", () => {
    setSandboxDir(undefined);
    assert.equal(isWithinSandbox("/tmp/pi-safetynet/abc/x", CWD), false);
  });

  it("accepts the root and descendants", () => {
    assert.equal(isWithinSandbox(SANDBOX, CWD), true);
    assert.equal(isWithinSandbox(`${SANDBOX}/out.txt`, CWD), true);
    assert.equal(isWithinSandbox(`${SANDBOX}/nested/deep/f`, CWD), true);
  });

  it("rejects a sibling sharing the prefix", () => {
    assert.equal(isWithinSandbox(`${SANDBOX}-evil/x`, CWD), false);
    assert.equal(isWithinSandbox("/tmp/pi-safetynet/abcd", CWD), false);
  });

  it("collapses .. traversal before comparing", () => {
    assert.equal(isWithinSandbox(`${SANDBOX}/../abc-evil/x`, CWD), false);
    assert.equal(isWithinSandbox(`${SANDBOX}/sub/../ok`, CWD), true);
  });

  it("resolves relative paths against cwd", () => {
    assert.equal(isWithinSandbox("scratch/out", SANDBOX), true);
    assert.equal(isWithinSandbox("scratch/out", CWD), false);
  });

  it("does not treat $HOME as the sandbox", () => {
    assert.equal(isWithinSandbox("~/x", CWD), false);
  });
});

describe("resolveAbsolute", () => {
  it("resolves relative paths and collapses ..", () => {
    assert.equal(resolveAbsolute("a/../b", "/p"), "/p/b");
    assert.equal(resolveAbsolute("/x/y/../z", "/p"), "/x/z");
  });
});

describe("ensureSandboxDir", () => {
  afterEach(() => setSandboxDir(undefined));

  it("creates a real directory and returns it without mutating the active slot", () => {
    const id = `test-${process.pid}-${Date.now()}`;
    const dir = ensureSandboxDir(id);
    try {
      assert.ok(dir);
      assert.equal(dir, computeSandboxDir(id));
      assert.ok(existsSync(dir));
      assert.equal(statSync(dir).isDirectory(), true);
      assert.equal(getSandboxDir(), undefined);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
