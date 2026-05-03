import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  isExternalPath,
  normalizePathForMatching,
  toDisplayPath,
  reanchorPattern,
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

describe("toDisplayPath", () => {
  it("converts in-project path to cwd-relative", () => {
    assert.equal(
      toDisplayPath("/project/src/foo.ts", { cwd: "/project/src", projectRoot: "/project" }),
      "foo.ts",
    );
  });

  it("converts in-project path above cwd to ../ form", () => {
    assert.equal(
      toDisplayPath("/project/README.md", { cwd: "/project/src", projectRoot: "/project" }),
      "../README.md",
    );
  });

  it("handles path equal to cwd", () => {
    // Node\'s relative() returns "" when path equals base
    assert.equal(
      toDisplayPath("/project/src", { cwd: "/project/src", projectRoot: "/project" }),
      "",
    );
  });

  it("handles ~-prefixed path inside project", () => {
    const home = process.env.HOME ?? "/home";
    // ~/project/src/foo.ts with cwd=~/project/src, root=~/project -> foo.ts
    assert.equal(
      toDisplayPath("~/project/src/foo.ts", { cwd: home + "/project/src", projectRoot: home + "/project" }),
      "foo.ts",
    );
  });

  it("returns relative paths as-is", () => {
    assert.equal(toDisplayPath("src/main.ts", { cwd: "/project", projectRoot: "/project" }), "src/main.ts");
  });

  it("converts $HOME-external path to ~/… form", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath(home + "/.config/app", { cwd: "/project", projectRoot: "/project" }),
      "~/.config/app",
    );
  });

  it("converts ~/… path outside project to ~/… form", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath("~/.ssh/config", { cwd: "/project", projectRoot: "/project" }),
      "~/.ssh/config",
    );
  });

  it("converts non-home external path to absolute", () => {
    assert.equal(
      toDisplayPath("/tmp/build.log", { cwd: "/project/src", projectRoot: "/project" }),
      "/tmp/build.log",
    );
  });

  it("converts /etc path to absolute", () => {
    assert.equal(
      toDisplayPath("/etc/hosts", { cwd: "/project", projectRoot: "/project" }),
      "/etc/hosts",
    );
  });

  it("converts in-project sibling dir path to ../ form", () => {
    assert.equal(
      toDisplayPath("/project/lib/utils.ts", { cwd: "/project/src", projectRoot: "/project" }),
      "../lib/utils.ts",
    );
  });
});

describe("reanchorPattern", () => {
  it("re-anchors cwd-relative pattern to project-root-relative", () => {
    assert.equal(
      reanchorPattern("foo.ts", "/home/user/project/src", "/home/user/project"),
      "src/foo.ts",
    );
  });

  it("is no-op when cwd equals project root", () => {
    assert.equal(
      reanchorPattern("foo.ts", "/home/user/project", "/home/user/project"),
      "foo.ts",
    );
  });

  it("re-anchors nested pattern", () => {
    assert.equal(
      reanchorPattern("components/*.ts", "/home/user/project/src", "/home/user/project"),
      "src/components/*.ts",
    );
  });

  it("resolves ../ patterns to project-root-relative", () => {
    assert.equal(
      reanchorPattern("../lib/utils.ts", "/home/user/project/src", "/home/user/project"),
      "lib/utils.ts",
    );
  });

  it("normalizes absolute patterns via normalizePathForMatching", () => {
    assert.equal(
      reanchorPattern("/home/user/project/src/foo.ts", "/home/user/project/src", "/home/user/project"),
      "src/foo.ts",
    );
  });

  it("converts rootless globs to recursive globs", () => {
    // *.ts → **/*.ts so it matches at any depth, not just top-level
    assert.equal(
      reanchorPattern("*.ts", "/home/user/project/src", "/home/user/project"),
      "**/*.ts",
    );
  });

  it("converts bare * to **", () => {
    assert.equal(reanchorPattern("*", "/home/user/project/src", "/home/user/project"), "**");
  });

  it("does not convert patterns with a directory component", () => {
    // src/*.ts has a directory prefix, so it should be reanchored normally
    assert.equal(
      reanchorPattern("components/*.ts", "/home/user/project/src", "/home/user/project"),
      "src/components/*.ts",
    );
  });

  it("rootless globs are recursive even when cwd equals project root", () => {
    assert.equal(
      reanchorPattern("*.ts", "/home/user/project", "/home/user/project"),
      "**/*.ts",
    );
  });
});
