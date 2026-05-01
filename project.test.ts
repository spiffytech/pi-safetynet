import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  isExternalPath,
  normalizePathForMatching,
} from "./project.ts";

describe("findProjectRoot", () => {
  const base = join(tmpdir(), `spfy-test-project-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("finds .pi in same directory", () => {
    assert.equal(findProjectRoot(base), base);
  });

  it("finds .pi in parent directory", () => {
    assert.equal(findProjectRoot(join(base, "src")), base);
  });

  it("finds .pi in grandparent directory", () => {
    assert.equal(findProjectRoot(join(base, "src", "sub")), base);
  });

  it("falls back to startPath when no .pi found", () => {
    const noPi = join(tmpdir(), `spfy-test-nopi-${Date.now()}`);
    try {
      mkdirSync(noPi, { recursive: true });
      assert.equal(findProjectRoot(noPi), noPi);
    } finally {
      rmSync(noPi, { recursive: true, force: true });
    }
  });
});

describe("isExternalPath", () => {
  it("flags /etc/passwd as external to /project", () => {
    assert.equal(isExternalPath("/etc/passwd", "/project"), true);
  });

  it("flags /tmp/file as external to /project", () => {
    assert.equal(isExternalPath("/tmp/file", "/project"), true);
  });

  it("does NOT flag /project/src/file.ts as external", () => {
    assert.equal(isExternalPath("/project/src/file.ts", "/project"), false);
  });

  it("does NOT flag /project itself as external", () => {
    assert.equal(isExternalPath("/project", "/project"), false);
  });

  it("does NOT flag relative paths inside project as external", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("src/main.ts", cwd), false);
  });

  it("does NOT flag ./-prefixed paths inside project as external", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("./src/main.ts", cwd), false);
  });

  it("flags ./../ traversal that escapes project", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("./../../../etc/passwd", cwd), true);
  });

  it("flags relative paths with .. that resolve outside project", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("../../../etc/passwd", cwd), true);
  });

  it("does NOT flag relative paths with .. that stay inside project", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("src/../other/file.ts", cwd), false);
  });

  it("flags sibling directory as external", () => {
    assert.equal(isExternalPath("/other-project/file.ts", "/project"), true);
  });

  it("flags path traversal via .. as external", () => {
    assert.equal(isExternalPath("/project/../../../etc/passwd", "/project"), true);
  });
});

describe("normalizePathForMatching", () => {
  it("strips project root prefix from absolute paths", () => {
    assert.equal(
      normalizePathForMatching("/project/src/main.ts", "/project"),
      "src/main.ts",
    );
  });

  it("converts project root itself to .", () => {
    assert.equal(normalizePathForMatching("/project", "/project"), ".");
  });

  it("strips ./ prefix", () => {
    assert.equal(normalizePathForMatching("./src/main.ts", "/project"), "src/main.ts");
  });

  it("leaves relative paths without ./ unchanged", () => {
    assert.equal(normalizePathForMatching("src/main.ts", "/project"), "src/main.ts");
  });

  it("leaves paths outside project root as-is", () => {
    assert.equal(
      normalizePathForMatching("/etc/passwd", "/project"),
      "/etc/passwd",
    );
  });

  it("normalizes ~ to home directory path", () => {
    const home = process.env.HOME ?? "/home";
    const result = normalizePathForMatching("~/foo", "/project");
    assert.ok(result.startsWith(home));
  });
});
