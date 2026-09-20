/**
 * store.ts — persisted state for inferred rules: accepted rules (the
 * enforcement side) and the pending proposal queue (the offer side).
 *
 * Both live in ONE file per scope, and both mutate it through the shared
 * `withJsonLock` read-modify-write helper. They must not be split into two
 * files: a lock is what makes concurrency safe, and a single document means
 * each writer preserves the other's key by spreading the incoming object.
 * (An earlier split-less version wrote each key as a whole document, so the
 * queue's persist erased accepted rules and the popup re-offered them every
 * session.)
 *
 * Reads re-read the file on every query rather than caching at construction,
 * so a rule accepted by another pi session is honored immediately. Session-
 * scoped rules stay memory-only (lost on restart — acceptable: they were
 * conveniences, and re-accepting is one keypress).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { ProfileName } from "../types.ts";
import { findPiConfigDir } from "../project.ts";
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

// ── Store paths ────────────────────────────────────────────────────────────

function projectStorePath(cwd: string): string {
  return join(findPiConfigDir(cwd), ".pi", "extensions", "safetynet", "inferred-rules.json");
}

function globalStorePath(): string {
  const dir = process.env.SAFETYNET_INFERRED_DIR ?? join(homedir(), ".config", "pi-safetynet");
  return join(dir, "inferred-rules.json");
}

// ─── Accepted rules ─────────────────────────────────────────────────────────

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

function rulesFrom(doc: unknown): InferredBashRule[] {
  const data = doc as { rules?: unknown } | null;
  return Array.isArray(data?.rules) ? (data.rules as unknown[]).filter(ruleFileFilter) : [];
}

export class InferredRuleStore {
  private sessionRules: InferredBashRule[] = [];
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  private readProject(): InferredBashRule[] {
    return rulesFrom(readJsonFile(projectStorePath(this.cwd)));
  }

  private readGlobal(): InferredBashRule[] {
    return rulesFrom(readJsonFile(globalStorePath()));
  }

  /** All accepted rules for enforcement, re-read from disk so rules accepted
   *  by other pi sessions are visible. Profile filtering is the caller's job
   *  (modes are stored on each rule). */
  all(): InferredBashRule[] {
    return [...this.sessionRules, ...this.readProject(), ...this.readGlobal()];
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
    const path = rule.scope === "global" ? globalStorePath() : projectStorePath(this.cwd);
    withJsonLock(path, (current) => {
      const rules = rulesFrom(current);
      // Re-check under the lock: another session may have accepted an
      // equivalent rule between our read and our write.
      if (rules.some((r) => r.render === rule.render)) return { result: undefined };
      rules.push(rule);
      return { result: undefined, next: { ...(current as object), version: 1, rules } };
    });
  }
}

// ─── Pending queue ──────────────────────────────────────────────────────────

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

function proposalsFrom(doc: unknown): PendingProposal[] {
  const data = doc as { proposals?: unknown } | null;
  return Array.isArray(data?.proposals) ? (data.proposals as unknown[]).filter(sanitizeProposal) : [];
}

function prune(proposals: PendingProposal[]): PendingProposal[] {
  const cutoff = Date.now() - QUEUE_TTL_MS;
  const fresh = proposals.filter((p) => p.createdAt >= cutoff);
  return fresh.length > QUEUE_CAP ? fresh.slice(fresh.length - QUEUE_CAP) : fresh;
}

export class ProposalQueue {
  private path: string | null;
  /** Memory-only fallback for a cwd-less queue (used by tests/edge callers). */
  private memory: PendingProposal[] = [];

  constructor(cwd?: string) {
    this.path = cwd ? projectStorePath(cwd) : null;
  }

  /** enqueue returns false when the proposal was suppressed as redundant. */
  enqueue(p: PendingProposal, opts: { suppressIfAllowed?: (exemplar: string) => boolean } = {}): boolean {
    if (!this.path) {
      if (this.memory.some((q) => q.render === p.render)) return false;
      if (opts.suppressIfAllowed?.(p.exemplars[0] ?? "")) return false;
      this.memory.push(p);
      return true;
    }
    const path = this.path;
    return withJsonLock(path, (current) => {
      const proposals = prune(proposalsFrom(current));
      if (proposals.some((q) => q.render === p.render)) return { result: false };
      if (opts.suppressIfAllowed?.(p.exemplars[0] ?? "")) return { result: false };
      proposals.push(p);
      return { result: true, next: { ...(current as object), version: 1, proposals } };
    });
  }

  list(): PendingProposal[] {
    if (!this.path) return prune(this.memory);
    return prune(proposalsFrom(readJsonFile(this.path)));
  }

  remove(id: string): PendingProposal | undefined {
    if (!this.path) {
      const idx = this.memory.findIndex((p) => p.id === id);
      if (idx === -1) return undefined;
      return this.memory.splice(idx, 1)[0];
    }
    const path = this.path;
    return withJsonLock(path, (current) => {
      const proposals = prune(proposalsFrom(current));
      const idx = proposals.findIndex((p) => p.id === id);
      if (idx === -1) return { result: undefined };
      const [removed] = proposals.splice(idx, 1);
      return { result: removed, next: { ...(current as object), version: 1, proposals } };
    });
  }
}