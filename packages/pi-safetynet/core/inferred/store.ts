/**
 * store.ts — persisted state for inferred rules: accepted rules (the
 * enforcement side) and the pending proposal queue (the offer side).
 *
 * One file under the global safetynet config dir holds everything:
 *   { version, rules: [...], projects: { "<cwd>": { rules: [...], proposals: [...] } } }
 *
 * `rules` is global scope; `projects[cwd]` is project scope keyed by the
 * session cwd. Project scoping used to be a separate file at the nearest `.pi`
 * (`findPiConfigDir`), which collapsed to `$HOME` for any project without its
 * own `.pi` — so "project" rules silently applied to every home-nested project.
 * A cwd key makes project scope actually per-project, with no directory sprawl.
 *
 * Every mutation goes through `withJsonLock` (exclusive lock + locked
 * read-modify-write + tmp+rename), so two pi sessions sharing this file cannot
 * lose each other's keys.
 *
 * Session-scoped rules stay memory-only (lost on restart — acceptable: they
 * were conveniences, and re-accepting is one keypress).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { ProfileName } from "../types.ts";
import { readJsonFile, withJsonLock } from "../json-store.ts";
import type { StructuralBashPattern } from "./shapes.ts";

const QUEUE_CAP = 20;
const QUEUE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

/** An accepted inferred rule. Enforcement is structural (token comparison),
 *  never via the regex pattern matcher. */
export interface InferredBashRule {
  id: string;
  render: string;
  pattern: StructuralBashPattern;
  modes: ProfileName[];
  /** Canonical subcommand strings this was generalized from (for narrowing
   *  later). Capped at 3. */
  exemplars: string[];
  scope: "session" | "project" | "global";
  acceptedAt: number;
}

/** A ripened shape awaiting user review. */
export interface PendingProposal {
  id: string;
  render: string;
  pattern: StructuralBashPattern;
  /** Canonical subcommand strings the shape was observed on. */
  exemplars: string[];
  count: number;
  createdAt: number;
}

// ─── Store location ────────────────────────────────────────────────────────

/** The single inferred-rules file. Project scope is a `projects[cwd]` key
 *  rather than a path, so there is exactly one file (and one lock) to contend
 *  with. SAFETYNET_INFERRED_DIR keeps tests hermetic. */
function storePath(): string {
  const dir = process.env.SAFETYNET_INFERRED_DIR ?? join(homedir(), ".config", "pi-safetynet");
  return join(dir, "inferred-rules.json");
}

// ─── Document helpers ──────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function ruleFileFilter(r: unknown): r is InferredBashRule {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.render === "string" &&
    typeof o.pattern === "object" && o.pattern !== null &&
    Array.isArray(o.modes) &&
    typeof o.scope === "string"
  );
}

function sanitizeProposal(p: unknown): p is PendingProposal {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.render === "string" &&
    typeof o.pattern === "object" && o.pattern !== null &&
    Array.isArray(o.exemplars) &&
    typeof o.count === "number" &&
    typeof o.createdAt === "number"
  );
}

/** Global-scope accepted rules (top-level `rules`). */
function globalRulesFrom(doc: unknown): InferredBashRule[] {
  const rules = asRecord(doc).rules;
  return Array.isArray(rules) ? (rules as unknown[]).filter(ruleFileFilter) : [];
}

function projectEntryFrom(doc: unknown, cwd: string): { rules: InferredBashRule[]; proposals: PendingProposal[] } {
  const entry = asRecord(asRecord(asRecord(doc).projects)[cwd]);
  return {
    rules: Array.isArray(entry.rules) ? (entry.rules as unknown[]).filter(ruleFileFilter) : [],
    proposals: Array.isArray(entry.proposals) ? (entry.proposals as unknown[]).filter(sanitizeProposal) : [],
  };
}

/** Write `projects[cwd]` back into a copy of the document, preserving every
 *  other key (global rules, other projects). */
function withProjectEntry(doc: unknown, cwd: string, update: (e: { rules: InferredBashRule[]; proposals: PendingProposal[] }) => void): unknown {
  const base = asRecord(doc);
  const projects = { ...asRecord(base.projects) };
  const entry = projectEntryFrom(doc, cwd);
  update(entry);
  projects[cwd] = entry;
  return { ...base, version: 1, projects };
}

function prune(proposals: PendingProposal[]): PendingProposal[] {
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const fresh = proposals.filter((p) => p.createdAt >= cutoff);
  return fresh.length > QUEUE_CAP ? fresh.slice(fresh.length - QUEUE_CAP) : fresh;
}

// ─── Accepted rules ─────────────────────────────────────────────────────────

export class InferredRuleStore {
  private sessionRules: InferredBashRule[] = [];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** All accepted rules for enforcement, re-read from disk so rules accepted
   *  by other pi sessions are visible. Profile filtering is the caller's job
   *  (modes are stored on each rule). */
  all(): InferredBashRule[] {
    const doc = readJsonFile(storePath());
    return [...this.sessionRules, ...globalRulesFrom(doc), ...projectEntryFrom(doc, this.cwd).rules];
  }

  /** True when an equivalent rule (same render) already exists at any scope —
   *  used to keep the popup from re-offering ratified rules. */
  hasEquivalent(render: string): boolean {
    return this.all().some((r) => r.render === render);
  }

  accept(rule: InferredBashRule): void {
    if (this.hasEquivalent(rule.render)) return;
    if (rule.scope === "session") {
      this.sessionRules.push(rule);
      return;
    }
    const cwd = this.cwd;
    withJsonLock(storePath(), (current) => {
      if (rule.scope === "global") {
        const rules = globalRulesFrom(current);
        // Re-check under the lock: another session may have accepted an
        // equivalent rule between our read and our write.
        if (rules.some((r) => r.render === rule.render)) return { result: undefined };
        rules.push(rule);
        return { result: undefined, next: { ...asRecord(current), version: 1, rules } };
      }
      return {
        result: undefined,
        next: withProjectEntry(current, cwd, (entry) => {
          if (!entry.rules.some((r) => r.render === rule.render)) entry.rules.push(rule);
        }),
      };
    });
  }
}

// ─── Pending queue ──────────────────────────────────────────────────────────

export class ProposalQueue {
  private cwd: string | null;
  /** Memory-only fallback for a cwd-less queue (used by tests/edge callers). */
  private memory: PendingProposal[] = [];

  constructor(cwd?: string) {
    this.cwd = cwd ?? null;
  }

  /** enqueue returns false when the proposal was suppressed as redundant. */
  enqueue(p: PendingProposal, opts: { suppressIfAllowed?: (exemplar: string) => boolean } = {}): boolean {
    if (!this.cwd) {
      if (this.memory.some((q) => q.render === p.render)) return false;
      if (opts.suppressIfAllowed?.(p.exemplars[0] ?? "")) return false;
      this.memory.push(p);
      return true;
    }
    const cwd = this.cwd;
    return withJsonLock(storePath(), (current) => {
      const proposals = prune(projectEntryFrom(current, cwd).proposals);
      if (proposals.some((q) => q.render === p.render)) return { result: false };
      if (opts.suppressIfAllowed?.(p.exemplars[0] ?? "")) return { result: false };
      proposals.push(p);
      return {
        result: true,
        next: withProjectEntry(current, cwd, (entry) => {
          entry.proposals = proposals;
        }),
      };
    });
  }

  list(): PendingProposal[] {
    if (!this.cwd) return prune(this.memory);
    return prune(projectEntryFrom(readJsonFile(storePath()), this.cwd).proposals);
  }

  remove(id: string): PendingProposal | undefined {
    if (!this.cwd) {
      const idx = this.memory.findIndex((p) => p.id === id);
      if (idx === -1) return undefined;
      return this.memory.splice(idx, 1)[0];
    }
    const cwd = this.cwd;
    return withJsonLock(storePath(), (current) => {
      const proposals = prune(projectEntryFrom(current, cwd).proposals);
      const idx = proposals.findIndex((p) => p.id === id);
      if (idx === -1) return { result: undefined };
      const [removed] = proposals.splice(idx, 1);
      return {
        result: removed,
        next: withProjectEntry(current, cwd, (entry) => {
          entry.proposals = proposals;
        }),
      };
    });
  }
}