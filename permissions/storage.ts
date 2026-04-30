import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Rule, Ruleset } from "../types.js";
import { findProjectRoot } from "../project.js";
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

class PersistedRuleStore {
  private rules: Ruleset = [];
  private filePath: string;
  private dirty = false;

  constructor(cwd: string) {
    const root = findProjectRoot(cwd);
    this.filePath = join(root, ".pi", "extensions", "spfy", "approvals.json");
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
      this.rules = data.rules ?? [];
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

export class PermissionStorage {
  session: SessionRuleStore;
  persisted: PersistedRuleStore;
  private cwd: string;

  constructor(_pi: ExtensionAPI, cwd: string) {
    this.cwd = cwd;
    this.session = new SessionRuleStore();
    this.persisted = new PersistedRuleStore(cwd);
  }

  async init(_ctx: ExtensionContext): Promise<void> {
    this.persisted.load();
  }

  getAllRules(): Ruleset {
    return [...BASELINE, ...this.persisted.getRules(), ...this.session.getRules()];
  }

  addSessionRules(rules: Ruleset): void {
    this.session.addRules(rules);
  }

  async addPersistedRules(rules: Ruleset): Promise<void> {
    await this.persisted.addRules(rules);
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
      (entry as { customType?: string }).customType === "spfy:session-rules"
    ) {
      const data = (entry as { data?: { rules?: Ruleset } }).data;
      if (data?.rules) rules.push(...data.rules);
    }
  }
  return rules;
}
