import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllowFlag } from "./index.ts";

describe("parseAllowFlag", () => {
  it("parses a single rule", () => {
    const rules = parseAllowFlag("edit: src/**");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
    ]);
  });

  it("parses multiple comma-separated rules", () => {
    const rules = parseAllowFlag("edit: src/**, bash: npm *");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
      { permission: "bash", pattern: "npm *", action: "allow", modes: ["build"] },
    ]);
  });

  it("trims whitespace around entries", () => {
    const rules = parseAllowFlag("  edit: src/**  ,  bash: npm test  ");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
      { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
    ]);
  });

  it("skips empty entries", () => {
    const rules = parseAllowFlag("edit: src/**,, bash: npm *,");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
      { permission: "bash", pattern: "npm *", action: "allow", modes: ["build"] },
    ]);
  });

  it("skips entries with invalid permission", () => {
    const rules = parseAllowFlag("invalid: src/**, edit: src/**");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
    ]);
  });

  it("skips entries with missing colon", () => {
    const rules = parseAllowFlag("no-colon, edit: src/**");
    assert.deepEqual(rules, [
      { permission: "edit", pattern: "src/**", action: "allow", modes: ["build"] },
    ]);
  });

  it("skips entries with empty pattern", () => {
    const rules = parseAllowFlag("edit: , bash: npm *");
    assert.deepEqual(rules, [
      { permission: "bash", pattern: "npm *", action: "allow", modes: ["build"] },
    ]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(parseAllowFlag(""), []);
    assert.deepEqual(parseAllowFlag("   "), []);
  });

  it("handles all valid permissions", () => {
    const rules = parseAllowFlag("bash: ls *, read: src/**, edit: src/**, *: *.ts");
    assert.equal(rules.length, 4);
    assert.equal(rules[0]!.permission, "bash");
    assert.equal(rules[1]!.permission, "read");
    assert.equal(rules[2]!.permission, "edit");
    assert.equal(rules[3]!.permission, "*");
  });
});
