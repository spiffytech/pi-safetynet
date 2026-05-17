import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findPiConfigDir,
  isExternalPath,
  normalizePathForMatching,
  toDisplayPath,
  fromDisplayPath,
  toRecursiveGlob,
  expandHome,
} from "./project.ts";

describe("findPiConfigDir", () => {
  const base = join(tmpdir(), `safetynet-test-project-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("finds .pi in same directory", () => {
    assert.equal(findPiConfigDir(base), base);
  });

  it("finds .pi in parent directory", () => {
    assert.equal(findPiConfigDir(join(base, "src")), base);
  });

  it("finds .pi in grandparent directory", () => {
    assert.equal(findPiConfigDir(join(base, "src", "sub")), base);
  });

  it("falls back to startPath when no .pi found", () => {
    const noPi = join(tmpdir(), `safetynet-test-nopi-${Date.now()}`);
    try {
      mkdirSync(noPi, { recursive: true });
      assert.equal(findPiConfigDir(noPi), noPi);
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

  it("does NOT flag relative paths inside cwd as external", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("src/main.ts", cwd), false);
  });

  it("does NOT flag ./-prefixed paths inside cwd as external", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("./src/main.ts", cwd), false);
  });

  it("flags ./../ traversal that escapes cwd", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("./../../../etc/passwd", cwd), true);
  });

  it("flags relative paths with .. that resolve outside cwd", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("../../../etc/passwd", cwd), true);
  });

  it("does NOT flag relative paths with .. that stay inside cwd", () => {
    const cwd = process.cwd();
    assert.equal(isExternalPath("src/../other/file.ts", cwd), false);
  });

  it("flags sibling directory as external", () => {
    assert.equal(isExternalPath("/other-project/file.ts", "/project"), true);
  });

  it("flags path traversal via .. as external", () => {
    assert.equal(isExternalPath("/project/../../../etc/passwd", "/project"), true);
  });

  it("expands ~ before checking — via expandHome", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(isExternalPath("~/project", home + "/project"), false);
    assert.equal(isExternalPath("~/other", home + "/project"), true);
    assert.equal(isExternalPath("~/project/src", home + "/project"), false);
  });
});

describe("expandHome", () => {
  it("expands ~/ to $HOME", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(expandHome("~/foo"), home + "/foo");
  });

  it("expands bare ~ to $HOME", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(expandHome("~"), home);
  });

  it("returns non-~-prefixed paths unchanged", () => {
    assert.equal(expandHome("/etc/passwd"), "/etc/passwd");
    assert.equal(expandHome("src/foo.ts"), "src/foo.ts");
    assert.equal(expandHome("."), ".");
  });
});

describe("normalizePathForMatching", () => {
  it("strips cwd prefix from absolute paths", () => {
    assert.equal(
      normalizePathForMatching("/project/src/main.ts", "/project"),
      "src/main.ts",
    );
  });

  it("converts cwd itself to .", () => {
    assert.equal(normalizePathForMatching("/project", "/project"), ".");
  });

  it("strips ./ prefix", () => {
    assert.equal(normalizePathForMatching("./src/main.ts", "/project"), "src/main.ts");
  });

  it("leaves relative paths without ./ unchanged", () => {
    assert.equal(normalizePathForMatching("src/main.ts", "/project"), "src/main.ts");
  });

  it("leaves paths outside cwd as-is", () => {
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

describe("toRecursiveGlob", () => {
  it("converts bare * to **", () => {
    assert.equal(toRecursiveGlob("*"), "**");
  });

  it("converts rootless globs to recursive globs", () => {
    assert.equal(toRecursiveGlob("*.ts"), "**/*.ts");
    assert.equal(toRecursiveGlob("*.spec.js"), "**/*.spec.js");
    assert.equal(toRecursiveGlob("*_test.*"), "**/*_test.*");
  });

  it("does not convert patterns with a directory component", () => {
    assert.equal(toRecursiveGlob("src/*.ts"), "src/*.ts");
    assert.equal(toRecursiveGlob("components/*.ts"), "components/*.ts");
  });

  it("does not convert non-glob patterns", () => {
    assert.equal(toRecursiveGlob("foo.ts"), "foo.ts");
    assert.equal(toRecursiveGlob("src/foo.ts"), "src/foo.ts");
  });
});

describe("toDisplayPath", () => {
  it("converts in-cwd path to cwd-relative", () => {
    assert.equal(
      toDisplayPath("/project/src/foo.ts", { cwd: "/project/src" }),
      "foo.ts",
    );
  });

  it("shows path above cwd as absolute (outside the working directory)", () => {
    assert.equal(
      toDisplayPath("/project/README.md", { cwd: "/project/src" }),
      "/project/README.md",
    );
  });

  it("handles path equal to cwd", () => {
    // Node's relative() returns "" when path equals base;
    // toDisplayPath converts that to "." for readability.
    assert.equal(
      toDisplayPath("/project/src", { cwd: "/project/src" }),
      ".",
    );
  });

  it("handles ~-prefixed path inside cwd", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath("~/project/src/foo.ts", { cwd: home + "/project/src" }),
      "foo.ts",
    );
  });

  it("handles ~-prefixed path equal to cwd", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath("~/project/src", { cwd: home + "/project/src" }),
      ".",
    );
  });

  it("returns relative paths as-is", () => {
    assert.equal(toDisplayPath("src/main.ts", { cwd: "/project" }), "src/main.ts");
  });

  it("converts $HOME-external path to ~/… form", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath(home + "/.config/app", { cwd: "/project" }),
      "~/.config/app",
    );
  });

  it("converts ~/… path outside cwd to ~/… form", () => {
    const home = process.env.HOME ?? "/home";
    assert.equal(
      toDisplayPath("~/.ssh/config", { cwd: "/project" }),
      "~/.ssh/config",
    );
  });

  it("converts non-home external path to absolute", () => {
    assert.equal(
      toDisplayPath("/tmp/build.log", { cwd: "/project/src" }),
      "/tmp/build.log",
    );
  });

  it("converts /etc path to absolute", () => {
    assert.equal(
      toDisplayPath("/etc/hosts", { cwd: "/project" }),
      "/etc/hosts",
    );
  });

  it("shows sibling dir path outside cwd as absolute", () => {
    assert.equal(
      toDisplayPath("/project/lib/utils.ts", { cwd: "/project/src" }),
      "/project/lib/utils.ts",
    );
  });
});

describe("fromDisplayPath", () => {
  it("resolves relative path against cwd", () => {
    assert.equal(
      fromDisplayPath("src/foo.ts", { cwd: "/project", home: "/home" }),
      "/project/src/foo.ts",
    );
  });

  it("resolves ../path against cwd", () => {
    assert.equal(
      fromDisplayPath("../lib/utils.ts", { cwd: "/project/src", home: "/home" }),
      "/project/lib/utils.ts",
    );
  });

  it("expands ~/ to home directory", () => {
    assert.equal(
      fromDisplayPath("~/.config/app", { cwd: "/project", home: "/home/user" }),
      "/home/user/.config/app",
    );
  });

  it("expands bare ~ to home directory", () => {
    assert.equal(
      fromDisplayPath("~", { cwd: "/project", home: "/home/user" }),
      "/home/user",
    );
  });

  it("keeps absolute paths as-is", () => {
    assert.equal(
      fromDisplayPath("/tmp/build.log", { cwd: "/project", home: "/home" }),
      "/tmp/build.log",
    );
  });

  it("resolves bare filename against cwd", () => {
    assert.equal(
      fromDisplayPath("foo.ts", { cwd: "/project/src", home: "/home" }),
      "/project/src/foo.ts",
    );
  });

  it("round-trips with toDisplayPath for in-cwd file", () => {
    const cwd = "/project/src";
    const absPath = "/project/src/foo.ts";
    const display = toDisplayPath(absPath, { cwd });
    const restored = fromDisplayPath(display, { cwd });
    assert.equal(restored, absPath);
  });

  it("round-trips with toDisplayPath for external home file", () => {
    const cwd = "/project";
    const home = process.env.HOME ?? "/home";
    const absPath = home + "/.config/app";
    const display = toDisplayPath(absPath, { cwd });
    const restored = fromDisplayPath(display, { cwd, home });
    assert.equal(restored, absPath);
  });

  it("round-trips with toDisplayPath for non-home external file", () => {
    const cwd = "/project";
    const absPath = "/tmp/build.log";
    const display = toDisplayPath(absPath, { cwd });
    const restored = fromDisplayPath(display, { cwd });
    assert.equal(restored, absPath);
  });
});
