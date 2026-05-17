import { existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

/**
 * Find the nearest ancestor directory containing a `.pi` config directory.
 * Used by storage to locate the pi config tree (e.g. ~/.pi or a project-local .pi).
 */
export function findPiConfigDir(startPath: string): string {
  let current = startPath;
  while (true) {
    if (existsSync(join(current, ".pi"))) {
      return current;
    }
    if (current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return startPath;
}

/** Expand `~` to `$HOME`. No-op for paths that don't start with `~`. */
export function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return join(process.env.HOME ?? "/home", path.slice(1));
  }
  return path;
}

export function isExternalPath(filePath: string, cwd: string): boolean {
  const expanded = expandHome(filePath);
  const absCwd = cwd.startsWith("/") ? cwd : join(process.cwd(), cwd);
  const resolvedPath = resolve(expanded);
  return !resolvedPath.startsWith(absCwd + "/") && resolvedPath !== absCwd;
}

/**
 * Convert a path to the most readable form for user display.
 *
 * - Paths inside cwd → cwd-relative (e.g. `src/foo.ts`, `../README.md`)
 * - Paths under $HOME but outside cwd → `~/…` (e.g. `~/.config/app`)
 * - Everything else → absolute (e.g. `/tmp/build.log`)
 */
export function toDisplayPath(filePath: string, opts?: { cwd?: string }): string {
  const cwd = opts?.cwd ?? process.cwd();
  const home = process.env.HOME ?? "/home";

  // Resolve to absolute for comparison
  let absPath = expandHome(filePath);
  if (!absPath.startsWith("/")) return filePath;

  // Inside cwd → cwd-relative
  if (!isExternalPath(absPath, cwd)) {
    const rel = relative(cwd, absPath);
    return rel === "" ? "." : rel;
  }

  // Under $HOME but outside cwd → ~/…
  if (absPath.startsWith(home + "/") || absPath === home) {
    return "~" + absPath.slice(home.length);
  }

  // Everything else → absolute
  return absPath;
}

/**
 * Detect "rootless glob" patterns that should match at any depth.
 *
 * In picomatch, '*.ts' only matches top-level files (e.g. 'test.ts'
 * but NOT 'src/test.ts').  Users who write '*.ts' almost always intend
 * it to match '.ts' files at any depth.  Converting the leading '*' to
 * '**\/' produces the expected recursive behaviour.
 *
 * Patterns that already have a directory component (e.g. 'src/*.ts',
 * 'dir/foo.*') are NOT rootless and are returned unchanged.
 */
export function toRecursiveGlob(pattern: string): string {
  // Only transform patterns whose first segment is a glob — that is,
  // the pattern starts with `*` and contains no `/` before the first
  // `*` (which would indicate a directory component).  We also handle
  // the bare `*` catch-all.
  if (pattern === "*") return "**";
  if (pattern.startsWith("*")) {
    const slashIdx = pattern.indexOf("/");
    if (slashIdx === -1) {
      // e.g. '*.ts', '*.spec.js', '*_test.*'
      return "**/" + pattern;
    }
  }
  return pattern;
}

/**
 * Reverse of `toDisplayPath`: convert a user-facing display path back to an
 * absolute path.
 *
 * - `~/...` → expand `$HOME`
 * - Relative path (no leading `/`, no `~`) → resolve relative to cwd
 * - Absolute path → keep as-is
 */
export function fromDisplayPath(displayPath: string, opts?: { cwd?: string; home?: string }): string {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? process.env.HOME ?? "/home";

  if (displayPath.startsWith("~/")) {
    return join(home, displayPath.slice(2));
  }
  if (displayPath === "~") {
    return home;
  }
  if (!displayPath.startsWith("/")) {
    return resolve(cwd, displayPath);
  }
  return displayPath;
}

export function normalizePathForMatching(filePath: string, cwd: string): string {
  let normalized = expandHome(filePath);

  if (normalized.startsWith("/")) {
    const absCwd = cwd.startsWith("/") ? cwd : join(process.cwd(), cwd);
    if (normalized.startsWith(absCwd + "/") || normalized === absCwd) {
      normalized = normalized.slice(absCwd.length + 1) || ".";
    }
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized || ".";
}
