/**
 * shapes.ts — structural shape analysis for inferred rules.
 *
 * Turns approved bash subcommands into structural "shapes", counts
 * occurrences, and merges repeated shapes into the least-general
 * generalization the observations license. Inferred rules are stored as
 * parsed structure and matched by a token comparator — never by the regex
 * pattern matcher (no `*` → `.*`, no greedy widening, no canonical/display
 * duality).
 *
 * Core distinctions (all lexical — zero per-command knowledge):
 *   - Program (token 0): always literal.
 *   - Flag tokens (start with `-`): always literal structure. Flag-name
 *     differences separate shapes (`grep -r` ≠ `grep -i`).
 *   - Assignment tokens (`key=value` where key is identifier-like and no
 *     `/` precedes the `=`): the KEY is literal structure, the value may
 *     slot when it varies. `dd if=<arg>` can never grow up to match `of=`.
 *   - First bare word after the program: structure (subcommand position).
 *     `git log` and `git branch` never merge.
 *   - Other bare words: free-slot candidates, allowed only as a trailing
 *     contiguous run (no interior wildcards).
 *   - Slots are single-token. A slot never matches a flag or assignment
 *     token, so a stored pattern cannot swallow flags it never observed
 *     (`git push <arg>` does not match `git push --force`).
 *
 * Failure mode by construction: a merge that cannot satisfy the rules
 * simply does not happen — no offer, status quo. The matcher may only ever
 * get stricter; see shapes.test.ts (negative corpus) before touching
 * anything in this file.
 */

import { isHazardousFile } from "../bash-parser.ts";

// ─── Token classification ───────────────────────────────────────────────────

export type TokenClass = "flag" | "assign" | "bare";

export interface ClassToken {
  /** Canonical (de-quoted) token text. May contain spaces (quoted words). */
  text: string;
  cls: TokenClass;
  /** For assign tokens: the key before the first `=`. */
  key?: string;
}

/** Identifier-like assignment key: `if=`, `BS`, `--eval=`? No — `--eval` is a
 *  flag with inline value form only reachable via a leading `-`, handled as a
 *  flag. Bare keys are identifier-ish and never path-like. */
const ASSIGN_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function classifyToken(text: string): ClassToken {
  if (text.startsWith("-")) return { text, cls: "flag" };
  const eq = text.indexOf("=");
  if (eq > 0 && !text.slice(0, eq).includes("/")) {
    const key = text.slice(0, eq);
    if (ASSIGN_KEY_RE.test(key)) return { text, cls: "assign", key };
  }
  return { text, cls: "bare" };
}

/** Classify a canonical token list. Returns null when the command is not
 *  shapeable (program missing or program is itself an assignment/flag). */
export function classifyTokens(tokens: string[]): ClassToken[] | null {
  if (tokens.length === 0) return null;
  const out: ClassToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = classifyToken(tokens[i]!);
    if (i === 0 && tok.cls !== "bare") return null; // program must be a bare word
    out.push(tok);
  }
  return out;
}

// ─── Shape keys ─────────────────────────────────────────────────────────────
// Two subcommands share a shape iff their structure matches: same program,
// same token count, same flag literals, same assignment keys, same first
// bare word (subcommand position). Everything else is abstracted.

export function shapeKeyOf(tokens: string[]): string | null {
  const cls = classifyTokens(tokens);
  if (!cls) return null;
  const parts: string[] = [];
  let seenBare = false;
  for (let i = 0; i < cls.length; i++) {
    const t = cls[i]!;
    if (i === 0) parts.push(`p:${t.text}`);
    else if (t.cls === "flag") parts.push(`f:${t.text}`);
    else if (t.cls === "assign") parts.push(`a:${t.key}`);
    else if (!seenBare) {
      seenBare = true;
      parts.push(`s:${t.text}`); // subcommand position: literal
    } else parts.push("b");
  }
  return parts.join("\u0000");
}

// ─── Execution-boundary tables (program-scoped) ────────────────────────────
// NO per-command grammars — only cross-cutting lexical universals.
// Every entry here must be covered by tests in shapes.test.ts (both the
// block direction and a harmless-flag negative).

/** (program, flag) pairs whose following token is code — the token after
 *  may never be a slot. Only dangerous pairs listed; `-c` on head/grep/cut
 *  etc. is deliberately absent. */
const EVAL_FLAG_PAIRS: Record<string, Set<string>> = {
  python: new Set(["-c"]),
  python3: new Set(["-c"]),
  node: new Set(["-e", "--eval", "-p"]),
  bun: new Set(["-e"]),
  ruby: new Set(["-e"]),
  perl: new Set(["-e", "-E", "-x"]),
  php: new Set(["-r"]),
  Rscript: new Set(["-e"]),
  R: new Set(["-e"]),
  osascript: new Set(["-e"]),
  mysql: new Set(["-e"]),
  psql: new Set(["-c"]),
  mongosh: new Set(["--eval"]),
  mongo: new Set(["--eval"]),
  lua: new Set(["-e"]),
  julia: new Set(["-e"]),
  elixir: new Set(["-e"]),
  erl: new Set(["-eval"]),
  gdb: new Set(["-ex", "-ix"]),
  sed: new Set(["-e", "-f"]),
};

/** Bare or flag tokens after which no slot may appear (the following token
 *  would be arbitrary code or an arbitrary command). */
const RUNNER_VERBS = new Set([
  "run", "exec", "xargs", "watch", "env", "nohup", "timeout", "nice",
  "strace", "setsid", "stdbuf", "ionice", "parallel", "foreach",
  "-exec", "-execdir", "-ok", "--exec",
]);

/** Rejection-taught boundaries (see learned.ts): tokens the user's drops
 *  identified as behaving like runner verbs. consulted alongside
 *  RUNNER_VERBS; persisted across sessions. */
const LEARNED_BOUNDARIES = new Set<string>();

export function learnBoundary(token: string): void {
  if (token) LEARNED_BOUNDARIES.add(token);
}

export function getLearnedBoundaries(): string[] {
  return [...LEARNED_BOUNDARIES];
}

/** Replace the learned set. The persisted file is the source of truth:
 *  loading it (including a missing/empty file) must be able to REMOVE a
 *  token, not only add one — otherwise a stale in-memory set survives
 *  deletion and gets written back on the next drop. */
export function setLearnedBoundaries(tokens: string[]): void {
  LEARNED_BOUNDARIES.clear();
  for (const t of tokens) LEARNED_BOUNDARIES.add(t);
}

/** Test-only: clear the process-global learned set between tests. */
export function resetLearnedBoundariesForTests(): void {
  LEARNED_BOUNDARIES.clear();
}

function isRunnerVerb(token: string): boolean {
  return RUNNER_VERBS.has(token) || LEARNED_BOUNDARIES.has(token);
}

/** Programs where no free slot may appear anywhere after the program
 *  position (remote/shell targets make every later argument code). */
const OPAQUE_PROGRAMS = new Set(["ssh"]);

/** Program + subcommand pairs after which every remaining argument stays
 *  literal (the subcommand's later args are arbitrary exec against the
 *  chosen image/target). */
const SUB_OPAQUE: Record<string, Set<string>> = {
  docker: new Set(["run", "exec", "create"]),
  podman: new Set(["run", "exec", "create"]),
  kubectl: new Set(["exec", "apply", "run", "create", "patch", "debug"]),
};

function isEvalFlag(program: string, tok: ClassToken): boolean {
  const flags = EVAL_FLAG_PAIRS[program];
  return !!flags && tok.cls === "flag" && flags.has(tok.text);
}

// ─── Structural patterns ────────────────────────────────────────────────────

export type PatternToken =
  | { kind: "lit"; text: string }
  | { kind: "assign"; key: string }
  | { kind: "slot" };

export interface StructuralBashPattern {
  tokens: PatternToken[];
}

/** Human rendering: `git commit -m <arg>`, `dd if=<arg> bs=<arg>`. */
export function renderPattern(p: StructuralBashPattern): string {
  return p.tokens
    .map((t) =>
      t.kind === "lit" ? t.text : t.kind === "assign" ? `${t.key}=<arg>` : "<arg>",
    )
    .join(" ");
}

/** True when `candidate` (canonical tokens) is admitted by the pattern. */
export function patternMatches(p: StructuralBashPattern, candidate: string[]): boolean {
  if (p.tokens.length !== candidate.length) return false;
  const cls = classifyTokens(candidate);
  if (!cls) return false;
  for (let i = 0; i < p.tokens.length; i++) {
    const pt = p.tokens[i]!;
    const ct = cls[i]!;
    if (pt.kind === "lit") {
      if (ct.text !== pt.text) return false;
    } else if (pt.kind === "assign") {
      if (ct.cls !== "assign" || ct.key !== pt.key) return false;
    } else {
      // slot: bare words only — never flags, never assignments
      if (ct.cls !== "bare") return false;
    }
  }
  return true;
}

// ─── Merge (least-general generalization) ───────────────────────────────────

export type MergeFailure =
  | { why: "flag-mismatch"; position: number }
  | { why: "assign-key-mismatch"; position: number }
  | { why: "subcommand-mismatch"; position: number }
  | { why: "interior-slot"; position: number }
  | { why: "boundary"; position: number; boundary: string }
  | { why: "hazard"; token: string }
  | { why: "token-count" };

export interface MergeOk {
  ok: true;
  pattern: StructuralBashPattern;
  /** Indices of free-slot positions (ascending). */
  slotPositions: number[];
}

export type MergeResult = MergeOk | { ok: false; failure: MergeFailure };

/**
 * Merge same-shape exemplar token arrays into the least-general pattern
 * covering them. Applies every structural rule plus boundary and hazard
 * validation. Returns failure (never a risky pattern) on any doubt.
 */
export function mergeExemplars(exemplars: string[][]): MergeResult {
  if (exemplars.length < 2) return { ok: false, failure: { why: "token-count" } };
  const first = exemplars[0]!;
  const n = first.length;
  const classed = exemplars.map((e) => classifyTokens(e));
  if (classed.some((c) => !c)) return { ok: false, failure: { why: "token-count" } };
  for (const e of exemplars) {
    if (e.length !== n) return { ok: false, failure: { why: "token-count" } };
  }

  const program = first[0]!;
  const cc = classed as ClassToken[][];
  const pattern: PatternToken[] = [];
  const slotPositions: number[] = [];

  // Free-slot candidates: bare positions (past the first-bare pin) whose
  // values differ across exemplars.
  const firstBareIdx = cc[0]!.findIndex((t, i) => i > 0 && t.cls === "bare");
  const candidates: number[] = [];
  for (let i = 1; i < n; i++) {
    const t0 = cc[0]![i]!;
    const allBare = cc.every((c) => c[i]!.cls === "bare");
    const differs = cc.some((c) => c[i]!.text !== first[i]);
    if (t0.cls === "bare" && allBare && i !== firstBareIdx && differs) {
      candidates.push(i);
    }
  }
  // Trailing rule: free-slot candidates must form a suffix of the token
  // list (positions m..n-1 all candidates, m = smallest candidate). The
  // program position (0) is never a candidate and is exempt.
  const m = candidates.length ? Math.min(...candidates) : -1;
  if (m >= 0) {
    for (let i = m; i < n; i++) {
      if (!candidates.includes(i)) {
        return { ok: false, failure: { why: "interior-slot", position: m } };
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const texts = cc.map((c) => c[i]!);
    const allSame = texts.every((t) => t.text === first[i]);
    if (i === 0) {
      if (!allSame) return { ok: false, failure: { why: "flag-mismatch", position: 0 } };
      pattern.push({ kind: "lit", text: first[i]! });
      continue;
    }
    const t0 = texts[0]!;
    if (t0.cls === "flag") {
      if (!allSame) return { ok: false, failure: { why: "flag-mismatch", position: i } };
      pattern.push({ kind: "lit", text: first[i]! });
      continue;
    }
    if (t0.cls === "assign") {
      const key = t0.key!;
      if (!texts.every((t) => t.cls === "assign" && t.key === key)) {
        return { ok: false, failure: { why: "assign-key-mismatch", position: i } };
      }
      const evalFlag = isEvalFlag(program, t0);
      if (!allSame) {
        if (evalFlag) {
          // eval flag assignment (--eval=<code>): value is code, never slot
          return { ok: false, failure: { why: "boundary", position: i, boundary: t0.key! } };
        }
        pattern.push({ kind: "assign", key });
        continue;
      }
      pattern.push({ kind: "lit", text: first[i]! });
      continue;
    }
    // bare
    if (i === firstBareIdx) {
      if (!allSame) return { ok: false, failure: { why: "subcommand-mismatch", position: i } };
      pattern.push({ kind: "lit", text: first[i]! });
      continue;
    }
    if (candidates.includes(i)) {
      pattern.push({ kind: "slot" });
      slotPositions.push(i);
    } else if (!allSame) {
      // Divergence at a non-slot position (e.g. flag-vs-bare-word mix at the
      // same index) — never literalize one exemplar's value.
      return { ok: false, failure: { why: "flag-mismatch", position: i } };
    } else {
      pattern.push({ kind: "lit", text: first[i]! });
    }
  }

  // Boundary validation on the assembled pattern.
  for (let i = 1; i < pattern.length; i++) {
    const pt = pattern[i]!;
    if (pt.kind !== "slot") continue;
    const prev = pattern[i - 1]!;
    // Slot directly after an eval flag = the code position.
    if (prev.kind === "lit") {
      const prevCls = classifyToken(prev.text);
      if (isEvalFlag(program, prevCls)) {
        return { ok: false, failure: { why: "boundary", position: i, boundary: prev.text } };
      }
      if (prevCls.cls === "bare" && isRunnerVerb(prev.text)) {
        return { ok: false, failure: { why: "boundary", position: i, boundary: prev.text } };
      }
      if (prevCls.cls === "flag" && isRunnerVerb(prev.text)) {
        return { ok: false, failure: { why: "boundary", position: i, boundary: prev.text } };
      }
    }
    // Class C: opaque programs / subcommands.
    if (OPAQUE_PROGRAMS.has(program)) {
      return { ok: false, failure: { why: "boundary", position: i, boundary: program } };
    }
    const subOpaque = SUB_OPAQUE[program];
    if (subOpaque && pattern[1]?.kind === "lit" && subOpaque.has(pattern[1].text)) {
      return { ok: false, failure: { why: "boundary", position: i, boundary: `${program} ${pattern[1].text}` } };
    }
  }

  // Hazard gate: no slot value may have been a hazardous path.
  for (const e of exemplars) {
    for (let i = 1; i < e.length; i++) {
      const tok = classifyToken(e[i]!);
      const value = tok.cls === "assign" ? e[i]!.slice(e[i]!.indexOf("=") + 1) : tok.cls === "bare" && i !== firstBareIdx ? e[i]! : null;
      if (value !== null && isHazardousFile(value)) {
        return { ok: false, failure: { why: "hazard", token: value } };
      }
    }
  }

  return { ok: true, pattern: { tokens: pattern }, slotPositions };
}

// ─── Record-time gating ─────────────────────────────────────────────────────

/** True when any slot-able value in the token list is a hazardous path —
 *  the shape must not ripen at all. */
export function hasHazardousValues(tokens: string[]): boolean {
  const cls = classifyTokens(tokens);
  if (!cls) return false;
  const firstBareIdx = cls.findIndex((t, i) => i > 0 && t.cls === "bare");
  for (let i = 1; i < tokens.length; i++) {
    const t = cls[i]!;
    let value: string | null = null;
    if (t.cls === "assign") value = tokens[i]!.slice(tokens[i]!.indexOf("=") + 1);
    else if (t.cls === "bare" && i !== firstBareIdx) value = t.text;
    if (value !== null && isHazardousFile(value)) return true;
  }
  return false;
}
