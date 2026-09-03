/**
 * Auto-approve toggle state persistence.
 * Mirrors the profiles persistence pattern (per-session custom entries).
 */
import type { AutoApproveConfig, AppendEntrySink, SessionEntriesSource } from "./types.ts";
import { getLatestCustomEntry } from "./profiles.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

let autoEnabled = false;

export function isAutoEnabled(): boolean {
  return autoEnabled;
}

export function setAutoEnabled(enabled: boolean, pi: AppendEntrySink): void {
  autoEnabled = enabled;
  pi.appendEntry("safetynet:auto", { enabled });
}

export function toggleAutoEnabled(pi: AppendEntrySink): boolean {
  autoEnabled = !autoEnabled;
  pi.appendEntry("safetynet:auto", { enabled: autoEnabled });
  return autoEnabled;
}

export function restoreAutoEnabled(ctx: SessionEntriesSource): void {
  const entry = getLatestCustomEntry<{ enabled: boolean }>(ctx, "safetynet:auto");
  if (entry?.data?.enabled !== undefined) autoEnabled = entry.data.enabled;
}

/** Reset auto to OFF for brand-new sessions (mirrors profile's isBrandNew reset). */
export function resetAutoEnabledForNewSession(): void {
  autoEnabled = false;
}

/** Load the auto-approve config from the global config file. */
/** Normalize the autoApprove.model config value. Accepts a single spec or an
 *  array (fallback chain, tried in order). Strings are trimmed; empties are
 *  dropped; a single-element array collapses to the bare string so existing
 *  single-model consumers see an unchanged shape. */
export function parseModelSpec(raw: unknown): string | string[] | undefined {
  if (typeof raw === "string") {
    const s = raw.trim();
    return s === "" ? undefined : s;
  }
  if (Array.isArray(raw)) {
    const list = raw.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim());
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0]!;
    return list;
  }
  return undefined;
}

export function loadAutoApproveConfig(): AutoApproveConfig {
  const configPath = join(homedir(), ".config", "pi-safetynet", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    const raw = data.autoApprove;
    if (!raw || typeof raw !== "object") return {};
    const model = parseModelSpec(raw.model);
    return {
      ...(model !== undefined ? { model } : {}),
      timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 90000,
      maxDenials: typeof raw.maxDenials === "number" ? raw.maxDenials : 3,
      retryIntervalMs: typeof raw.retryIntervalMs === "number" ? raw.retryIntervalMs : 30000,
      maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : 2,
    };
  } catch {
    return {};
  }
}