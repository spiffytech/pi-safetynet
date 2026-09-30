/**
 * json-store.test.ts — the shared locked read-modify-write contract.
 *
 * These lock in the two properties the inferred/approvals/config stores rely
 * on: sibling keys survive a mutation (spread semantics), and the lock is
 * released so the next writer can proceed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, withJsonLock } from "./json-store.ts";

function tmpPath(name = "doc.json"): string {
  return join(mkdtempSync(join(tmpdir(), "safetynet-json-")), name);
}

describe("json-store", () => {
  it("readJsonFile returns null for missing and corrupt files", () => {
    const path = tmpPath("corrupt.json");
    assert.equal(readJsonFile(path), null, "missing file");
    writeFileSync(path, "{ not json");
    assert.equal(readJsonFile(path), null, "corrupt file degrades to empty");
  });

  it("withJsonLock performs a read-modify-write and returns the caller's result", () => {
    const path = tmpPath();
    const result = withJsonLock(path, (current) => ({
      result: 42,
      next: { ...(current as object), a: 1 },
    }));
    assert.equal(result, 42);
    assert.deepEqual(readJsonFile(path), { a: 1 });
  });

  it("successive writers preserve each other's keys (no clobber)", () => {
    const path = tmpPath();
    withJsonLock(path, (current) => ({ result: undefined, next: { ...(current as object), rules: ["r"] } }));
    withJsonLock(path, (current) => ({ result: undefined, next: { ...(current as object), proposals: ["p"] } }));
    assert.deepEqual(readJsonFile(path), { rules: ["r"], proposals: ["p"] });
  });

  it("omitting next leaves the file untouched", () => {
    const path = tmpPath();
    withJsonLock(path, () => ({ result: undefined, next: { keep: true } }));
    const before = readFileSync(path, "utf-8");
    withJsonLock(path, () => ({ result: undefined }));
    assert.equal(readFileSync(path, "utf-8"), before);
  });

  it("releases the lock so a second writer can acquire it", () => {
    const path = tmpPath();
    withJsonLock(path, () => ({ result: undefined, next: { n: 1 } }));
    // A leaked lock would make this second acquire exhaust its retries and throw.
    withJsonLock(path, (current) => ({ result: undefined, next: { ...(current as object), n: 2 } }));
    assert.deepEqual(readJsonFile(path), { n: 2 });
  });
});