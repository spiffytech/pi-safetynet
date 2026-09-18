/**
 * counters.ts — session-scoped shape counters for inferred rules.
 *
 * Counts structurally-identical approved subcommands (same shape key).
 * When a shape reaches k occurrences it "ripens": the exemplars are merged
 * into the least-general structural pattern they license, and the caller is
 * invited to offer it. Nothing here persists — accepted rules are the
 * cross-session memory (plans/inferred-rules-design.md §2).
 *
 * Failure mode by construction: a shape whose exemplars cannot merge
 * (interior slots, boundary violations, hazards) is marked unripenable and
 * never offered, no matter how many more times it recurs.
 */

import { shapeKeyOf, mergeExemplars, type StructuralBashPattern, type MergeFailure } from "./shapes.ts";

/** Occurrences required before a shape ripens. Small by design: two
 *  approvals in one session is weak-but-human-gated evidence, and the judge
 *  plus review popup are the quality gates. */
export const RIPEN_THRESHOLD = 2;

/** Cap on stored exemplars per shape (memory bound; the merge only needs a
 *  representative sample). */
const MAX_EXEMPLARS = 3;

export interface ShapeEntry {
  count: number;
  /** Canonical token lists, most recent last. */
  exemplars: string[][];
  /** Set once the shape has ripened (offer already made) — or on first
   *  failed merge, in which case the shape never ripens. */
  ripened?: boolean;
  unripenable?: MergeFailure;
}

export interface RipenedShape {
  key: string;
  pattern: StructuralBashPattern;
  exemplars: string[][];
  count: number;
}

export class ShapeCounters {
  private shapes = new Map<string, ShapeEntry>();

  /**
   * Record one approved subcommand's canonical tokens. Returns a ripened
   * shape exactly once per shape (at the moment the threshold is crossed
   * with a valid merge); later records of an already-ripened shape return
   * nothing.
   */
  record(tokens: string[]): RipenedShape | null {
    const key = shapeKeyOf(tokens);
    if (!key) return null;

    let entry = this.shapes.get(key);
    if (!entry) {
      entry = { count: 0, exemplars: [] };
      this.shapes.set(key, entry);
    }
    entry.count++;
    if (entry.ripened || entry.unripenable) return null;
    if (entry.exemplars.length < MAX_EXEMPLARS) entry.exemplars.push(tokens);

    if (entry.count < RIPEN_THRESHOLD || entry.exemplars.length < RIPEN_THRESHOLD) return null;

    const merge = mergeExemplars(entry.exemplars);
    if (!merge.ok) {
      entry.unripenable = merge.failure;
      return null;
    }
    entry.ripened = true; // offer made exactly once per shape
    return { key, pattern: merge.pattern, exemplars: entry.exemplars.slice(), count: entry.count };
  }

  get(key: string): ShapeEntry | undefined {
    return this.shapes.get(key);
  }

  reset(): void {
    this.shapes.clear();
  }
}
