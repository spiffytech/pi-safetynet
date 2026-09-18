/**
 * store.ts — persisted state for inferred rules: accepted rules (the
 * enforcement side) and the pending proposal queue (the offer side).
 *
 * Deliberately NOT stored in the global config.json or approvals.json:
 * those use unserialized read-modify-write whose parse-error path can wipe
 * existing rules. Inferred rules get their own files with atomic
 * tmp+rename writes. Session-scoped accepted rules are memory-only (lost on
 * restart — acceptable: they were conveniences, and re-accepting is one
 * keypress).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ProfileName } from "../types.ts";
import { findPiConfigDir } from "../project.ts";
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

// ─── Atomic JSON file helpers ───────────────────────────────────────────────

export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // corrupt file → treated as empty; never throws into the ask path
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

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

export class InferredRuleStore {
  private sessionRules: InferredBashRule[] = [];
  private projectRules: InferredBashRule[] = [];
  private globalRules: InferredBashRule[] = [];
  private loadedGlobal = false;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    const path = projectStorePath(cwd);
    const data = readJsonFile(path) as { rules?: unknown } | null;
    if (Array.isArray(data?.rules)) {
      this.projectRules = (data.rules as unknown[]).filter(ruleFileFilter);
    }
  }

  /** All accepted rules for enforcement. Profile filtering is the caller's
   *  job (modes are stored on each rule). */
  all(): InferredBashRule[] {
    this.ensureGlobalLoaded();
    return [...this.sessionRules, ...this.projectRules, ...this.globalRules];
  }

  /** True when an equivalent rule (same render, same or wider scope) already
   *  exists — used to keep the popup from re-offering ratified rules. */
  hasEquivalent(render: string): boolean {
    this.ensureGlobalLoaded();
    return (
      this.sessionRules.some((r) => r.render === render) ||
      this.projectRules.some((r) => r.render === render) ||
      this.globalRules.some((r) => r.render === render)
    );
  }

  accept(rule: InferredBashRule): void {
    if (this.hasEquivalent(rule.render)) return;
    if (rule.scope === "session") {
      this.sessionRules.push(rule);
      return;
    }
    const path = rule.scope === "global" ? globalStorePath() : projectStorePath(this.cwd);
    const data = readJsonFile(path) as { rules?: unknown[] } | null;
    const rules = Array.isArray(data?.rules) ? data!.rules!.filter(ruleFileFilter) : [];
    rules.push(rule);
    writeJsonAtomic(path, { version: 1, rules });
    if (rule.scope === "global") this.globalRules.push(rule);
    else this.projectRules.push(rule);
  }

  private ensureGlobalLoaded(): void {
    if (this.loadedGlobal) return;
    this.loadedGlobal = true;
    const data = readJsonFile(globalStorePath()) as { rules?: unknown } | null;
    if (Array.isArray(data?.rules)) {
      this.globalRules = (data.rules as unknown[]).filter(ruleFileFilter);
    }
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

export class ProposalQueue {
  private proposals: PendingProposal[] = [];
  private path: string | null = null;
  private loaded = false;

  constructor(cwd?: string) {
    if (cwd) {
      this.path = projectStorePath(cwd);
      const data = readJsonFile(this.path) as { proposals?: unknown } | null;
      if (Array.isArray(data?.proposals)) {
        this.proposals = (data.proposals as unknown[]).filter(sanitizeProposal);
      }
      this.loaded = true;
    }
  }

  private persist(): void {
    if (!this.path) return;
    writeJsonAtomic(this.path, { version: 1, proposals: this.proposals });
  }

  /** Drop stale/over-cap entries; called lazily on list(). */
  private prune(): void {
    const cutoff = Date.now() - QUEUE_TTL_MS;
    this.proposals = this.proposals.filter((p) => p.createdAt >= cutoff);
    if (this.proposals.length > QUEUE_CAP) {
      this.proposals = this.proposals.slice(this.proposals.length - QUEUE_CAP);
    }
  }

  /** enqueue returns false when the proposal was suppressed as redundant. */
  enqueue(p: PendingProposal, opts: { suppressIfAllowed?: (exemplar: string) => boolean } = {}): boolean {
    this.ensureLoaded();
    this.prune();
    if (this.proposals.some((q) => q.render === p.render)) return false;
    if (opts.suppressIfAllowed?.(p.exemplars[0] ?? "")) return false;
    this.proposals.push(p);
    this.persist();
    return true;
  }

  list(): PendingProposal[] {
    this.ensureLoaded();
    this.prune();
    return [...this.proposals];
  }

  remove(id: string): PendingProposal | undefined {
    this.ensureLoaded();
    const idx = this.proposals.findIndex((p) => p.id === id);
    if (idx === -1) return undefined;
    const [p] = this.proposals.splice(idx, 1);
    this.persist();
    return p;
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loaded = true;
      // cwd-less queue is memory-only; nothing to load.
    }
  }
}
