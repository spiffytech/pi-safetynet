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

export function isExternalPath(filePath: string, projectRoot: string): boolean {
  const absRoot = projectRoot.startsWith("/") ? projectRoot : join(process.cwd(), projectRoot);
  const resolvedPath = resolve(filePath);
  return !resolvedPath.startsWith(absRoot + "/") && resolvedPath !== absRoot;
}

/**
 * Convert a path to the most readable form for user display.
 *
 * - Paths inside the project root → cwd-relative (e.g. `src/foo.ts`, `../README.md`)
 * - Paths under $HOME but outside the project → `~/…` (e.g. `~/.config/app`)
 * - Everything else → absolute (e.g. `/tmp/build.log`)
 */
export function toDisplayPath(filePath: string, opts?: { cwd?: string; projectRoot?: string }): string {
  const base = opts?.cwd ?? process.cwd();
  const home = process.env.HOME ?? "/home";
  const root = opts?.projectRoot ?? base;

  // Resolve to absolute for comparison
  let absPath = filePath;
  if (absPath.startsWith("~")) {
    absPath = join(home, absPath.slice(1));
  }
  if (!absPath.startsWith("/")) return filePath;

  // Inside project root → cwd-relative
  if (!isExternalPath(absPath, root)) {
    return relative(base, absPath);
  }

  // Under $HOME but outside project → ~/…
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
 * 'dir/foo.*') are NOT rootless and should be reanchored normally.
 */
function toRecursiveGlob(pattern: string): string {
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
 * Re-anchor a cwd-relative pattern to be project-root-relative.
 *
 * When cwd is a subdirectory of project root, a pattern like 'foo.ts'
 * (meaning "foo.ts relative to cwd") needs to become 'sub/foo.ts'
 * (meaning "foo.ts relative to project root") for correct rule matching.
 *
 * Rootless glob patterns (e.g. '*.ts') are converted to recursive globs
 * (e.g. '**\/*.ts') so they match at any depth, since that is almost
 * always what the user intends.  Without this, '*.ts' only matches
 * top-level files in picomatch.
 */
export function reanchorPattern(pattern: string, cwd: string, projectRoot: string): string {
  // Convert rootless globs to recursive globs first.
  // This also ensures they are NOT reanchored with a cwd prefix, since
  // **/ already matches at every depth.
  const recursive = toRecursiveGlob(pattern);
  if (recursive !== pattern) return recursive;

  // Expand ~ to home directory — picomatch treats ~ as literal, not $HOME.
  // After expansion the path is absolute; normalizePathForMatching handles it.
  if (pattern.startsWith("~")) {
    const expanded = join(process.env.HOME ?? "/home", pattern.slice(1));
    return normalizePathForMatching(expanded, projectRoot);
  }

  // If the pattern is already absolute, normalize it for matching
  if (pattern.startsWith("/")) return normalizePathForMatching(pattern, projectRoot);

  // Compute the relative path from project root to cwd
  // e.g. if root=/project and cwd=/project/src, result = "src"
  const cwdRelative = relative(projectRoot, cwd);

  // If cwd IS the project root, no re-anchoring needed
  if (cwdRelative === "." || cwdRelative === "") return pattern;

  // Patterns starting with ../ mean the user pointed above cwd but
  // potentially below the project root. Resolve to absolute first.
  if (pattern.startsWith("..")) {
    const abs = resolve(cwd, pattern);
    return normalizePathForMatching(abs, projectRoot);
  }

  // Prepend the cwd-relative-to-root prefix
  // e.g. pattern "foo.ts" with cwdRelative "src" -> "src/foo.ts"
  return cwdRelative + "/" + pattern;
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

export function normalizePathForMatching(filePath: string, projectRoot: string): string {
  let normalized = filePath;

  if (normalized.startsWith("~")) {
    normalized = join(process.env.HOME ?? "/home", normalized.slice(1));
  }

  if (normalized.startsWith("/")) {
    const absRoot = projectRoot.startsWith("/") ? projectRoot : join(process.cwd(), projectRoot);
    if (normalized.startsWith(absRoot + "/") || normalized === absRoot) {
      normalized = normalized.slice(absRoot.length + 1) || ".";
    }
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }

  return normalized || ".";
}
