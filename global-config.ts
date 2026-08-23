import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AutoDenyConfig, KeybindingsConfig, Paradigm, ProfileName, Ruleset } from "./types.ts";
import type { PromptKeybindings } from "./prompts.ts";
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
  paradigm?: Paradigm | string;
  trustExternalPaths?: boolean;
  keybindings?: KeybindingsConfig;
  autoDeny?: AutoDenyConfig;
  /** Remappable key for the plan/build toggle global shortcut. Default "ctrl+\\". */
  toggleModeKey?: string;
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
  if (val === "plan" || val === "build" || val === "ro" || val === "rw") return val;
  return undefined;
}

/** Load the active mode paradigm (plan/build vs ro/rw). Defaults to plan/build. */
export function loadParadigm(): Paradigm {
  const config = loadConfig();
  if (config.paradigm === "ro-rw" || config.paradigm === "plan-build") return config.paradigm;
  return "plan-build";
}

/** Load trustExternalPaths from global config. Returns false if unset or not a boolean. */
export function loadTrustExternalPaths(): boolean {
  const config = loadConfig();
  return config.trustExternalPaths === true;
}

/** Load configurable prompt keybindings. Returns sanitized defaults when unset. */
export function loadKeybindings(): PromptKeybindings {
  const config = loadConfig();
  const raw: KeybindingsConfig = config.keybindings ?? {};
  const out: PromptKeybindings = { denyAbort: "escape" };
  // Normalise to lowercase key ids (pi-tui matches lowercase single chars).
  // Reject empty strings (a bound key must be non-empty to be meaningful).
  if (typeof raw.denyContinue === "string" && raw.denyContinue.trim().length > 0) {
    out.denyContinue = raw.denyContinue.trim().toLowerCase();
  }
  if (typeof raw.denyAbort === "string" && raw.denyAbort.trim().length > 0) {
    out.denyAbort = raw.denyAbort.trim().toLowerCase();
  } else {
    // Default: Esc aborts the turn (preserves historical behaviour).
    out.denyAbort = "escape";
  }
  return out;
}

/** Load auto-deny behaviour for rule/headless denials. */
export function loadAutoDeny(): AutoDenyConfig {
  const config = loadConfig();
  const raw = config.autoDeny ?? {};
  const out: AutoDenyConfig = { continue: raw.continue === true };
  const reason = typeof raw.reason === "string" && raw.reason.trim().length > 0
    ? raw.reason.trim()
    : undefined;
  if (reason !== undefined) out.reason = reason;
  return out;
}

/** Load the toggle-plan/build shortcut key. Default "ctrl+\\". */
export function loadToggleModeKey(): string {
  const config = loadConfig();
  const raw = config.toggleModeKey;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "ctrl+\\";
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
