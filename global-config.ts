import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProfileName, Ruleset } from "./types.ts";
import { sanitizeRules } from "./permissions/storage.ts";

/** Directory for global config — `~/.config/pi-safetynet/` */
export function getGlobalConfigDir(): string {
  return join(homedir(), ".config", "pi-safetynet");
}

/** Path to the global config file — `~/.config/pi-safetynet/config.json` */
export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), "config.json");
}

interface GlobalConfig {
  rules?: Ruleset;
  subagents?: string[] | null;
  defaultProfile?: ProfileName;
  [key: string]: unknown;
}

/** Load the full global config file, returning an empty object if missing/unreadable. */
function loadConfig(): GlobalConfig {
  const path = getGlobalConfigPath();
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof data === "object" && data !== null) return data as GlobalConfig;
  } catch {
    // ignore parse errors
  }
  return {};
}

/** Save a full config object to disk, creating the directory if needed. */
function saveConfig(config: GlobalConfig): void {
  const dir = getGlobalConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    getGlobalConfigPath(),
    JSON.stringify(config, null, 2) + "\n",
    "utf-8",
  );
}

/** Load and validate the rules from the global config. Invalid entries are silently dropped. */
export function loadGlobalRules(): Ruleset {
  const config = loadConfig();
  if (!Array.isArray(config.rules)) return [];
  return sanitizeRules(config.rules);
}

/** Replace the rules in the global config file, preserving other keys. */
export function saveGlobalRules(rules: Ruleset): void {
  const config = loadConfig();
  config.rules = rules;
  saveConfig(config);
}

/** Load the default profile from global config. Returns undefined if unset or invalid. */
export function loadDefaultProfile(): ProfileName | undefined {
  const config = loadConfig();
  const val = config.defaultProfile;
  if (val === "plan" || val === "build") return val;
  return undefined;
}

/** Save the default profile to global config, preserving other keys. */
export function saveDefaultProfile(profile: ProfileName): void {
  const config = loadConfig();
  config.defaultProfile = profile;
  saveConfig(config);
}

/** Which subagent tools to enable. Defaults to all if key is omitted or null. Empty array disables all. */
export function loadSubagentsConfig(): string[] {
  const config = loadConfig();
  if (config.subagents == null) return ["subagent_explore", "subagent_build"];
  return config.subagents;
}

/** Append rules to the global config and save. Returns the full updated ruleset. */
export function addGlobalRules(newRules: Ruleset): Ruleset {
  const existing = loadGlobalRules();
  const updated = [...existing, ...newRules];
  saveGlobalRules(updated);
  return updated;
}
