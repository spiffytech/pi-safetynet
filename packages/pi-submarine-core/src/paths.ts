import { join, resolve, relative } from "node:path";

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
  // Resolve relative inputs against the session cwd, not process.cwd().
  const resolvedPath = expanded.startsWith("/") ? resolve(expanded) : resolve(absCwd, expanded);
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

  // read-tool line/range selectors (:241, :241-462, :50+150, :raw, :img) are
  // not part of the file path: strip any trailing run of them so a permission
  // approval for a path also covers selector-qualified reads of it.
  normalized = normalized.replace(/(?::(?:\d+(?:-\d+|\+\d+)?|raw|img))+$/, "");

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

/** Unicode whitespace the file-tool path resolver folds before opening a path
 *  (mirrors pi's `normalizeUnicodeSpaces`). */
const TOOL_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Normalize a file-tool path argument the way the harness's path resolver does
 *  before it opens the file: strip a single leading `@` and fold unicode
 *  spaces. The permission check and any minted rule must name the path actually
 *  touched — otherwise `read @.env` opens `.env` while the hazardous-file check
 *  and rules see the inert string `@.env` (baseline `read: **` allows it).
 *
 *  Applies to the file tools (read/edit/write/grep/find/ls) and their omp
 *  equivalents. Do NOT apply to bash redirect targets: bash treats `@`
 *  literally, so `> @foo` writes a file named `@foo`. */
export function normalizeToolPath(filePath: string): string {
  let normalized = filePath;
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  return normalized.replace(TOOL_UNICODE_SPACES, " ");
}

/**
 * Sensitive-file guard: true for paths whose contents are secrets (`.env`,
 * keys, credential files). Pure path matching — shared by every child session
 * so a read-only child cannot exfiltrate what the parent would deny.
 */
export function isSensitivePath(filePath: string): boolean {
  // Case-folded: on case-insensitive filesystems (macOS/Windows) `.ENV` opens
  // the same file as `.env`, so a case-sensitive check is a bypass. On
  // case-sensitive filesystems an uppercase name is a different file; denying
  // it is fail-closed, which the hazardous path tolerates by design.
  const lower = filePath.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;

  const allowed = [".env.example", ".env.sample", ".env.template", ".sample.env"];
  if (allowed.some((e) => lower.endsWith(e))) return false;

  if (/^\.env(\.[^.]+)*$/.test(basename)) return true;
  if (basename === ".envrc") return true;
  if (basename === ".npmrc") return true;
  if (basename === ".pypirc") return true;
  if (basename === ".netrc") return true;
  if (basename === ".dockercfg") return true;

  if (/^id_(rsa|ed25519|ecdsa)$/.test(basename)) return true;
  if (/\.pem$/.test(basename)) return true;

  if (/^credentials\.(json|ya?ml)$/.test(basename)) return true;
  if (/^secrets\.(json|ya?ml)$/.test(basename)) return true;

  if (/\.ssh[\\/]/.test(lower)) return true;
  if (/\.gnupg[\\/]/.test(lower)) return true;
  if (/\.aws[\\/]credentials/.test(lower)) return true;
  if (/\.docker[\\/]config\.json/.test(lower)) return true;

  return false;
}
