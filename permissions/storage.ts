import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Rule, Ruleset, TempRule, ProfileName } from "../types.ts";
import { findProjectRoot } from "../project.ts";
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
  private rules: Ruleset = [];
  private filePath: string;

  constructor(cwd: string) {
    const root = findProjectRoot(cwd);
    this.filePath = join(root, ".pi", "extensions", "safetynet", "approvals.json");
  }

  getFilePath(): string {
    return this.filePath;
  }

  getRules(): Ruleset {
    return [...this.rules];
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.rules = [];
      return;
    }
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.rules = sanitizeRules(data.rules ?? []);
    } catch {
      this.rules = [];
    }
  }

  async save(rules: Ruleset): Promise<void> {
    this.rules = [...rules];
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const sorted = [...this.rules].sort((a, b) => {
      const order: Record<string, number> = { bash: 0, edit: 1, read: 2, "*": 3 };
      return (order[a.permission] ?? 4) - (order[b.permission] ?? 4);
    });
    writeFileSync(this.filePath, JSON.stringify({ rules: sorted }, null, 2) + "\n", "utf-8");
  }

  async addRules(newRules: Ruleset): Promise<void> {
    this.rules.push(...newRules);
    await this.save(this.rules);
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
  private rules: Ruleset = [];

  getRules(): Ruleset {
    return [...this.rules];
  }

  load(): void {
    this.rules = loadGlobalRules();
  }

  async addRules(newRules: Ruleset): Promise<void> {
    this.rules = addGlobalRulesToConfig(newRules);
  }
}

export class PermissionStorage {
  session: SessionRuleStore;
  persisted: PersistedRuleStore;
  global: GlobalRuleStore;
  temp: TempRuleStore;
  private cwd: string;

  constructor(_pi: ExtensionAPI, cwd: string) {
    this.cwd = cwd;
    this.session = new SessionRuleStore();
    this.persisted = new PersistedRuleStore(cwd);
    this.global = new GlobalRuleStore();
    this.temp = new TempRuleStore();
  }

  async init(_ctx: ExtensionContext): Promise<void> {
    this.persisted.load();
    this.global.load();
  }

  getAllRules(): Ruleset {
    return [...BASELINE, ...this.global.getRules(), ...this.persisted.getRules(), ...this.session.getRules(), ...this.temp.getRules()];
  }

  addSessionRules(rules: Ruleset): void {
    this.session.addRules(rules);
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
