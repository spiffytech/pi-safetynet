/**
 * Auto-approve toggle state persistence.
 * Mirrors the profiles persistence pattern (per-session custom entries).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoApproveConfig } from "./types.ts";
import { getLatestCustomEntry } from "./profiles/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let autoEnabled = false;

export function isAutoEnabled(): boolean {
  return autoEnabled;
}

export function setAutoEnabled(enabled: boolean, pi: ExtensionAPI): void {
  autoEnabled = enabled;
  pi.appendEntry("safetynet:auto", { enabled });
}

export function toggleAutoEnabled(pi: ExtensionAPI): boolean {
  autoEnabled = !autoEnabled;
  pi.appendEntry("safetynet:auto", { enabled: autoEnabled });
  return autoEnabled;
}

export function restoreAutoEnabled(ctx: ExtensionContext): void {
  const entry = getLatestCustomEntry<{ enabled: boolean }>(ctx, "safetynet:auto");
  if (entry?.data?.enabled !== undefined) autoEnabled = entry.data.enabled;
}

/** Reset auto to OFF for brand-new sessions (mirrors profile's isBrandNew reset). */
export function resetAutoEnabledForNewSession(): void {
  autoEnabled = false;
}

/** Load the auto-approve config from the global config file. */
export function loadAutoApproveConfig(): AutoApproveConfig {
  const configPath = join(homedir(), ".config", "pi-safetynet", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    const raw = data.autoApprove;
    if (!raw || typeof raw !== "object") return {};
    return {
      model: typeof raw.model === "string" ? raw.model : undefined,
      timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 90000,
      maxDenials: typeof raw.maxDenials === "number" ? raw.maxDenials : 3,
      retryIntervalMs: typeof raw.retryIntervalMs === "number" ? raw.retryIntervalMs : 30000,
      maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : 2,
    };
  } catch {
    return {};
  }
}