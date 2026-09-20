/**
 * learned.ts — rejection-fed boundary tokens.
 *
 * When the user drops a proposed rule, the token immediately preceding each
 * free slot is recorded as a learned execution boundary (it behaved like a
 * runner verb in the user's judgment). Learned boundaries persist globally
 * (they are tool universals, not project facts) in their own atomic-write
 * file — never config.json (adversarial finding #4).
 *
 * shapes.ts consults the learned set in its boundary validation: a slot may
 * never immediately follow a learned boundary token.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getLearnedBoundaries, setLearnedBoundaries } from "./shapes.ts";
import { readJsonFile, writeJsonAtomic } from "../json-store.ts";

function learnedPath(): string {
  const dir = process.env.SAFETYNET_INFERRED_DIR ?? join(homedir(), ".config", "pi-safetynet");
  return join(dir, "learned-boundaries.json");
}

/** Prime the in-memory learned set from disk. Call once per session start
 *  (and on session switch/tree navigation). Authoritative: a missing or
 *  empty file CLEARS the set, so deleting the file actually takes effect. */
export function loadLearnedBoundaries(): void {
  const data = readJsonFile(learnedPath()) as { tokens?: unknown } | null;
  const tokens = Array.isArray(data?.tokens)
    ? (data.tokens as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  setLearnedBoundaries(tokens);
}

export function saveLearnedBoundaries(): void {
  writeJsonAtomic(learnedPath(), { version: 1, tokens: getLearnedBoundaries() });
}
