/**
 * sandbox.ts — per-session scratch space.
 *
 * Both read-only and read-write modes allow reads and writes under one
 * session-named directory, so throwaway files (command output, scratch
 * fixtures, code handed to a sandboxed tool) don't need an approval. The
 * directory is computed once per session and announced in the system prompt;
 * the permission layer treats it as an allow-subtree.
 *
 * Hazardous names (`.env`, `id_rsa`, …) stay denied inside the sandbox too.
 * The guard is a pure path-name check, so exempting the sandbox would require
 * knowing what a path actually resolves to (a symlink/hardlink or a copy that
 * planted a real secret under a trusted name), which is not statically
 * decidable.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { expandHome } from "pi-submarine-core";

/** Root under which per-session sandboxes live. */
function sandboxBase(): string {
  return join(tmpdir(), "pi-safetynet");
}

/** Sanitize a session id for use as a single directory name. */
function sanitizeSessionId(sessionId: string): string {
  const cleaned = sessionId
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+$/, "_"); // "."/".." would escape the base directory
  return cleaned || "session";
}

/** Compute the sandbox directory for a session. Pure. */
export function computeSandboxDir(sessionId: string): string {
  return join(sandboxBase(), sanitizeSessionId(sessionId));
}

/** Active session's sandbox directory, or undefined when none is set. */
let currentSandboxDir: string | undefined;

export function getSandboxDir(): string | undefined {
  return currentSandboxDir;
}

export function setSandboxDir(dir: string | undefined): void {
  currentSandboxDir = dir;
}

/**
 * Create the sandbox directory for a session (mode 0700) and return its path.
 * Returns undefined when creation fails so callers keep a stable fallback and
 * never announce a path they cannot write.
 */
export function ensureSandboxDir(sessionId: string): string | undefined {
  const dir = computeSandboxDir(sessionId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a user-supplied path to a normalized absolute path for sandbox
 * comparison. Purely lexical (`~` expansion + `..` collapse); symlinks are not
 * followed — an accepted limitation under the trust-the-model premise.
 */
export function resolveAbsolute(filePath: string, cwd: string): string {
  const expanded = expandHome(filePath);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

/**
 * True when `filePath` resolves inside the active session sandbox. Boundary-
 * checked, so a sibling like `<sandbox>-evil` is not inside `<sandbox>`.
 */
export function isWithinSandbox(filePath: string, cwd: string): boolean {
  const dir = currentSandboxDir;
  if (!dir) return false;
  const abs = resolveAbsolute(filePath, cwd);
  const base = normalize(dir);
  return abs === base || abs.startsWith(base + sep);
}
