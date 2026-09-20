/**
 * judge.ts — the deferred model call that decides whether a ripened shape
 * becomes an offer, and at what width.
 *
 * The judge NEVER widens. Its only degrees of freedom:
 *   - reject a shape outright (risky programs, egress, destructive nuance),
 *   - accept the mechanical merge as-is,
 *   - accept a PIN VARIANT: fix some slot positions to observed exemplar
 *     values, producing a narrower rule.
 * Every candidate is mechanically re-validated here — the judge cannot talk
 * the validator into a wider or boundary-violating pattern.
 *
 * The judge runs as one background call per ripened shape (off the ask hot
 * path) and shares the reviewer's model configuration. It must not reuse the
 * reviewer's turn-token / pending-result machinery (process-global
 * singletons — plans/inferred-rules-design.md §9).
 */

import type { StructuralBashPattern, PatternToken } from "./shapes.ts";
import { patternMatches, renderPattern } from "./shapes.ts";
import { isHazardousFile } from "../bash-parser.ts";

export interface JudgeInput {
  render: string;
  pattern: StructuralBashPattern;
  /** Canonical subcommand strings the shape was observed on. */
  exemplars: string[];
  /** Canonical token lists parallel to `exemplars`. */
  exemplarTokens: string[][];
  count: number;
}

export interface JudgeOffer {
  kind: "offer";
  rationale: string;
  /** Validated candidates, judge's rank order. The full merge (no pins) is
   *  always present as the last resort even if the judge omits it. */
  candidates: StructuralBashPattern[];
  annotations: string[];
}

export type JudgeVerdict =
  | JudgeOffer
  | { kind: "reject"; rationale: string }
  | { kind: "transient"; message: string };

export interface JudgeDeps {
  /** Runs the judge model and returns its text output. Injected so tests
   *  stub it and frontends adapt their own spawner. */
  ask: (prompt: string) => Promise<string>;
}

export const JUDGE_SYSTEM_PROMPT = `You are a permission-rule safety judge. You review a proposed permission rule that was generalized from actions a user has manually approved during this session. Targets are bash commands, or tool-permission targets of the form \`tool:<name>\` (a tool approved in a read-only session); judge both the same way. Your verdict decides whether the user is shown an offer to add it permanently.

You must be conservative. Approve only patterns where the varying parts are genuinely innocuous. Reject when:
- the program is capable of destructive or irreversible action (deletion, overwriting, force-pushing, disk writes),
- the command performs network egress whose destination varies,
- the varying argument is code, a script path, or anything executable,
- generalizing feels likely to surprise the user later.

Output STRICT JSON only, no prose:
{"verdict":"offer","rationale":"<one sentence>","candidates":[{"pins":{"<slotIndex>":"<observedValue>"},"note":"<one sentence>"}]}
{"verdict":"reject","rationale":"<one sentence>"}

"pins" narrows the rule by fixing slot positions to values the user actually approved (omit for the full generalization). At most 2 candidates, most natural first. When in doubt, reject.`;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface JudgeJson {
  verdict?: unknown;
  rationale?: unknown;
  candidates?: unknown;
}

/** Rebuild a pattern with slots pinned to the given literal values. */
function applyPins(
  pattern: StructuralBashPattern,
  pins: Record<number, string>,
): StructuralBashPattern | null {
  const tokens: PatternToken[] = pattern.tokens.map((t, i) => {
    if (t.kind === "slot" && Object.prototype.hasOwnProperty.call(pins, i)) {
      return { kind: "lit", text: pins[i]! };
    }
    return t;
  });
  return { tokens };
}

/** Mechanical validation of a judge candidate. Returns null when valid, or
 *  the reason it was refused. */
function validateCandidate(
  candidate: StructuralBashPattern,
  input: JudgeInput,
): string | null {
  // 1. Candidates may retain merge slots or pin them to observed literals,
  //    but may never alter literals/assignment keys the merge established.
  for (let i = 0; i < candidate.tokens.length; i++) {
    const c = candidate.tokens[i]!;
    const m = input.pattern.tokens[i]!;
    if (m.kind === "lit" && (c.kind !== "lit" || c.text !== m.text)) {
      return "candidate changed a literal";
    }
    if (m.kind === "assign" && (c.kind !== "assign" || c.key !== m.key)) {
      return "candidate changed an assignment key";
    }
    // m.slot + c.lit = pin (observed-value check below); m.slot + c.slot = retained.
  }
  // 2. Pinned values must be observed exemplar values at that position.
  for (let i = 0; i < candidate.tokens.length; i++) {
    const c = candidate.tokens[i]!;
    if (c.kind !== "lit") continue;
    const m = input.pattern.tokens[i]!;
    if (m.kind !== "slot") continue;
    const observed = input.exemplarTokens.some((e) => e[i] === c.text);
    if (!observed) return `pinned value ${JSON.stringify(c.text)} was never observed`;
  }
  // 3. Hazard check on concretized values (assignments keep abstract keys;
  //    only newly-literal tokens carry concrete paths).
  for (const c of candidate.tokens) {
    if (c.kind === "lit" && isHazardousFile(c.text)) {
      return `pinned value ${c.text} is a sensitive path`;
    }
  }
  // 4. The candidate must still match at least one exemplar.
  const matchesAny = input.exemplarTokens.some((e) => patternMatches(candidate, e));
  if (!matchesAny) return "candidate matches none of its exemplars";
  return null;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const lines = input.exemplarTokens.map((t) => t.join(" "));
  return [
    "A bash command shape recurred during this session and was generalized mechanically.",
    `Generalized rule: ${input.render}`,
    `Observed ${input.count} times. Exemplar commands:`,
    ...lines.map((l) => `  - ${l}`),
    "",
    "Decide: offer this rule to the user, reject it, or offer a narrower pin variant.",
    "Return strict JSON only.",
  ].join("\n");
}

export async function runInferredJudge(input: JudgeInput, deps: JudgeDeps): Promise<JudgeVerdict> {
  let text: string;
  try {
    text = await deps.ask(buildJudgePrompt(input));
  } catch (err) {
    return { kind: "transient", message: String(err) };
  }

  const parsed = extractJson(text) as JudgeJson | null;
  if (!parsed || typeof parsed !== "object") {
    return { kind: "transient", message: "Judge returned unparseable output" };
  }
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";

  if (parsed.verdict === "reject") {
    return { kind: "reject", rationale: rationale || "Judge declined without a reason" };
  }
  if (parsed.verdict !== "offer") {
    return { kind: "transient", message: `Unknown judge verdict: ${String(parsed.verdict)}` };
  }

  // Validate candidates; the full merge is always included as the last
  // resort so a judge that returns garbage candidates still yields the
  // mechanically-safe offer.
  const candidates: StructuralBashPattern[] = [];
  const annotations: string[] = [];
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  for (const raw of rawCandidates) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.pins !== "object" || o.pins === null) continue;
    const pins: Record<number, string> = {};
    let valid = true;
    for (const [k, v] of Object.entries(o.pins)) {
      const pos = Number(k);
      if (!Number.isInteger(pos) || typeof v !== "string") { valid = false; break; }
      if (input.pattern.tokens[pos]?.kind !== "slot") { valid = false; break; } // pin at non-slot position: meaningless
      pins[pos] = v;
    }
    if (!valid) continue;
    const built = applyPins(input.pattern, pins);
    if (!built) continue;
    const problem = validateCandidate(built, input);
    if (problem) continue;
    candidates.push(built);
    if (typeof o.note === "string") annotations.push(o.note);
  }
  candidates.push(input.pattern); // full merge, always mechanically valid

  return { kind: "offer", rationale: rationale || "Judge approved", candidates, annotations };
}
