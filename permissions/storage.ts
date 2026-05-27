import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Rule, Ruleset, TempRule, ProfileName } from "../types.ts";
import { findPiConfigDir } from "../project.ts";
import { loadGlobalRules, addGlobalRules as addGlobalRulesToConfig } from "../global-config.ts";
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
const VALID_MODES = new Set(["plan", "build"]);

export function sanitizeRules(raw: unknown[]): Ruleset {
  return raw.filter((r): r is Rule => {
    if (typeof r !== "object" || r === null) return false;
    const rule = r as Record<string, unknown>;
    if (!VALID_PERMISSIONS.has(rule.permission as string)) return false;
    if (typeof rule.pattern !== "string") return false;
    if (!VALID_ACTIONS.has(rule.action as string)) return false;
    if (!Array.isArray(rule.modes) || rule.modes.length === 0) return false;
    if (!(rule.modes as string[]).every((m) => VALID_MODES.has(m))) return false;
    return true;
  });
}

class PersistedRuleStore {
  private filePath: string;

  constructor(cwd: string) {
    const root = findPiConfigDir(cwd);
    this.filePath = join(root, ".pi", "extensions", "safetynet", "approvals.json");
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Re-read rules from disk on every call so other sessions' approvals are visible. */
  getRules(): Ruleset {
    if (!existsSync(this.filePath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return sanitizeRules(data.rules ?? []);
    } catch {
      return [];
    }
  }

  /** Validate the file is readable at startup. */
  load(): void {
    // Trigger a read to catch parse errors early; result is not cached.
    this.getRules();
  }

  async save(rules: Ruleset): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const sorted = [...rules].sort((a, b) => {
      const order: Record<string, number> = { bash: 0, edit: 1, read: 2, "*": 3 };
      return (order[a.permission] ?? 4) - (order[b.permission] ?? 4);
    });
    writeFileSync(this.filePath, JSON.stringify({ rules: sorted }, null, 2) + "\n", "utf-8");
  }

  async addRules(newRules: Ruleset): Promise<void> {
    const current = this.getRules();
    current.push(...newRules);
    await this.save(current);
  }
}

/**
 * Temporary rule store for time-limited and turn-limited approvals.
 * Rules are checked on each getAllRules() call and expired ones are pruned.
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

  /** Prune expired time-limited rules and return the surviving regular rules. */
  getRules(): Ruleset {
    const now = Date.now();
    this.rules = this.rules.filter((r) => {
      if (r.expiry.type === "time") return r.expiry.expiresAt > now;
      return true; // "turn" rules survive until explicitly cleared
    });
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

  constructor(_pi: ExtensionAPI, cwd: string) {
    this.cwd = cwd;
    this.session = new SessionRuleStore();
    this.persisted = new PersistedRuleStore(cwd);
    this.global = new GlobalRuleStore();
    this.flag = new SessionRuleStore();
    this.temp = new TempRuleStore();
  }

  async init(_ctx: ExtensionContext): Promise<void> {
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
  ctx: ExtensionContext,
): Ruleset {
  const entries = ctx.sessionManager.getBranch();
  const rules: Ruleset = [];
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      (entry as { customType?: string }).customType === "safetynet:session-rules"
    ) {
      const data = (entry as { data?: { rules?: Ruleset } }).data;
      if (data?.rules) rules.push(...data.rules);
    }
  }
  return rules;
}
