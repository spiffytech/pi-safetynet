import type { Rule, Ruleset, TempRule, ProfileName, SessionJournalSource } from "../types.ts";
import { readJsonFile, withJsonLock } from "../json-store.ts";
import { loadGlobalRules, addGlobalRules as addGlobalRulesToConfig, getGlobalConfigPath } from "../global-config.ts";
import baselineData from "./baseline.json" with { type: "json" };

const BASELINE: Ruleset = baselineData.rules as Ruleset;

export function getBaselineRules(): Ruleset {
  return BASELINE;
}

class SessionRuleStore {
  private rules: Ruleset = [];

  getRules(): Ruleset {
    return [...this.rules];
  }

  addRules(rules: Ruleset): void {
    this.rules.push(...rules);
  }

  clear(): void {
    this.rules = [];
  }
}

const VALID_ACTIONS = new Set(["allow", "deny", "ask"]);
const VALID_PERMISSIONS = new Set(["bash", "edit", "read", "*"]);
const VALID_MODES = new Set(["plan", "build", "ro", "rw"]);

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function sanitizeRules(raw: unknown[]): Ruleset {
  return raw.filter((r): r is Rule => {
    if (typeof r !== "object" || r === null) return false;
    const rule = r as Record<string, unknown>;
    if (!VALID_PERMISSIONS.has(rule.permission as string)) return false;
    if (typeof rule.pattern !== "string") return false;
    if (!VALID_ACTIONS.has(rule.action as string)) return false;
    if (!Array.isArray(rule.modes) || rule.modes.length === 0) return false;
    if (!(rule.modes as string[]).every((m) => VALID_MODES.has(m))) return false;
    if (rule.reason !== undefined && typeof rule.reason !== "string") return false;
    return true;
  });
}

class PersistedRuleStore {
  /** Project scope is a `projectRules[cwd]` key in the global safetynet
   *  config, not a file at the nearest `.pi` — that collapsed to $HOME for any
   *  project without a local `.pi`, silently leaking "project" rules across
   *  every home-nested project. */
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** Re-point at another project (resume/switch can change the session cwd). */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** The project key these rules are stored under (for display). */
  getKey(): string {
    return this.cwd;
  }

  getFilePath(): string {
    return getGlobalConfigPath();
  }

  /** Re-read rules from disk on every call so other sessions' approvals are visible. */
  getRules(): Ruleset {
    const config = asRecord(readJsonFile(getGlobalConfigPath()));
    const rules = asRecord(config.projectRules)[this.cwd];
    return Array.isArray(rules) ? sanitizeRules(rules) : [];
  }

  /** Validate the file is readable at startup. */
  load(): void {
    // Trigger a read to catch parse errors early; result is not cached.
    this.getRules();
  }

  async addRules(newRules: Ruleset): Promise<void> {
    const cwd = this.cwd;
    withJsonLock(getGlobalConfigPath(), (current) => {
      const config = asRecord(current);
      const projectRules = { ...asRecord(config.projectRules) };
      const existing = Array.isArray(projectRules[cwd]) ? sanitizeRules(projectRules[cwd] as unknown[]) : [];
      const merged = [...existing, ...newRules];
      merged.sort((a, b) => {
        const order: Record<string, number> = { bash: 0, edit: 1, read: 2, "*": 3 };
        return (order[a.permission] ?? 4) - (order[b.permission] ?? 4);
      });
      projectRules[cwd] = merged;
      return { result: undefined, next: { ...config, projectRules } };
    });
  }
}

/**
 * Temporary rule store for turn-limited approvals.
 */
export class TempRuleStore {
  private rules: TempRule[] = [];

  addRules(rules: TempRule[]): void {
    this.rules.push(...rules);
  }

  /** Remove all turn-limited rules. Called on agent_end. */
  clearTurnRules(): void {
    this.rules = this.rules.filter((r) => r.expiry.type !== "turn");
  }

  /** Return the surviving regular rules. */
  getRules(): Ruleset {
    return this.rules.map((r) => r.rule);
  }

  clear(): void {
    this.rules = [];
  }

  /** Number of active temp rules (for display). */
  get count(): number {
    return this.rules.length;
  }
}

export class GlobalRuleStore {
  /** Re-read rules from disk on every call so other sessions' approvals are visible. */
  getRules(): Ruleset {
    return loadGlobalRules();
  }

  /** Validate the config is readable at startup. */
  load(): void {
    // Trigger a read to catch parse errors early; result is not cached.
    this.getRules();
  }

  async addRules(newRules: Ruleset): Promise<void> {
    addGlobalRulesToConfig(newRules);
  }
}

export class PermissionStorage {
  session: SessionRuleStore;
  persisted: PersistedRuleStore;
  global: GlobalRuleStore;
  flag: SessionRuleStore;
  temp: TempRuleStore;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.session = new SessionRuleStore();
    this.persisted = new PersistedRuleStore(cwd);
    this.global = new GlobalRuleStore();
    this.flag = new SessionRuleStore();
    this.temp = new TempRuleStore();
  }

  async init(): Promise<void> {
    this.persisted.load();
    this.global.load();
  }

  getAllRules(): Ruleset {
    return [...BASELINE, ...this.global.getRules(), ...this.persisted.getRules(), ...this.flag.getRules(), ...this.session.getRules(), ...this.temp.getRules()];
  }

  addSessionRules(rules: Ruleset): void {
    this.session.addRules(rules);
  }

  addFlagRules(rules: Ruleset): void {
    this.flag.addRules(rules);
  }

  addTempRules(rules: TempRule[]): void {
    this.temp.addRules(rules);
  }

  async addPersistedRules(rules: Ruleset): Promise<void> {
    await this.persisted.addRules(rules);
  }

  async addGlobalRules(rules: Ruleset): Promise<void> {
    await this.global.addRules(rules);
  }
}

export function reconstructSessionRules(
  journal: SessionJournalSource,
  currentCwd: string,
): { rules: Ruleset; skippedCount: number } {
  const entries = journal.sessionManager.getBranch();
  const rules: Ruleset = [];
  let skippedCount = 0;
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "safetynet:session-rules"
    ) {
      const data = entry.data as { rules?: Ruleset; cwd?: string } | undefined;
      if (data?.rules) {
        if (data.cwd && data.cwd !== currentCwd) {
          skippedCount++;
        } else {
          rules.push(...data.rules);
        }
      }
    }
  }
  return { rules, skippedCount };
}
