/**
 * Auto-approve toggle state persistence.
 * Mirrors the profiles persistence pattern (per-session custom entries).
 */
import type { AutoApproveConfig, AppendEntrySink, SessionJournalSource } from "./types.ts";
import { getLatestCustomEntry } from "./profiles.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** The classifier model we ship as the default: TypeSafe Jev. It is sharper
 *  and better calibrated than clef-flash on mined session data. Any provider's
 *  `type: "classifier"` model works instead. */
export const DEFAULT_CLASSIFIER_MODEL = "typesafe/jev-latest";
/** Minimum P(allow) for the classifier's `allow` choice. Below this, the
 *  action asks the user instead of running on a weak allow. */
export const DEFAULT_CLASSIFIER_THRESHOLD = 0.6;

export type ReviewMode = "one-shot" | "session" | "classifier";

/** Auto-approve defaults ON only when a reviewer model is configured;
 *  without one the reviewer would run against a fallback model. Classifier
 *  mode is self-sufficient because it has a built-in default model. */
export function hasReviewerModel(): boolean {
  const config = loadAutoApproveConfig();
  return config.model !== undefined || reviewMode() === "classifier";
}

let autoEnabled = hasReviewerModel();

export function isAutoEnabled(): boolean {
  return autoEnabled;
}

export function setAutoEnabled(enabled: boolean, pi: AppendEntrySink): void {
  autoEnabled = enabled;
  pi.appendEntry("safetynet:auto", { enabled });
}

export function toggleAutoEnabled(pi: AppendEntrySink): { enabled: boolean; blockedReason?: string } {
  // off→on requires a reviewer model; on→off is always allowed.
  if (!autoEnabled && !hasReviewerModel()) {
    return {
      enabled: false,
      blockedReason:
        "no autoApprove.model configured in ~/.config/pi-safetynet/config.json — auto-approve needs a reviewer model to judge actions",
    };
  }
  autoEnabled = !autoEnabled;
  pi.appendEntry("safetynet:auto", { enabled: autoEnabled });
  return { enabled: autoEnabled };
}

export function restoreAutoEnabled(ctx: SessionJournalSource): void {
  const entry = getLatestCustomEntry<{ enabled: boolean }>(ctx, "safetynet:auto");
  if (entry?.data?.enabled !== undefined) autoEnabled = entry.data.enabled;
}

/** Reset auto to the config default for brand-new sessions: ON only when a
 *  reviewer model is configured (mirrors profile's isBrandNew reset). */
export function resetAutoEnabledForNewSession(): void {
  autoEnabled = hasReviewerModel();
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
    const classifierModel = parseModelSpec(raw.classifierModel);
    const threshold =
      typeof raw.classifierThreshold === "number" && Number.isFinite(raw.classifierThreshold)
        ? Math.min(1, Math.max(0, raw.classifierThreshold))
        : DEFAULT_CLASSIFIER_THRESHOLD;
    return {
      ...(model !== undefined ? { model } : {}),
      timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 90000,
      maxDenials: typeof raw.maxDenials === "number" ? raw.maxDenials : 3,
      latencyWarnEmaMs: typeof raw.latencyWarnEmaMs === "number" ? raw.latencyWarnEmaMs : 8000,
      reviewMode:
        raw.reviewMode === "session"
          ? "session"
          : raw.reviewMode === "classifier"
            ? "classifier"
            : "one-shot",
      ...(classifierModel !== undefined ? { classifierModel } : {}),
      classifierThreshold: threshold,
    };
  } catch {
    return {};
  }
}

/** The active review methodology. Env SAFETYNET_REVIEW_MODE ("session" /
 *  "one-shot" / "classifier") overrides the config file for quick flipping;
 *  anything else falls through to `autoApprove.reviewMode`, defaulting to the
 *  one-shot reviewer. */
export function reviewMode(): ReviewMode {
  const env = process.env.SAFETYNET_REVIEW_MODE?.trim();
  if (env === "session" || env === "one-shot" || env === "classifier") return env;
  return loadAutoApproveConfig().reviewMode ?? "one-shot";
}

/** Model specs the active methodology should try, in order. One-shot/session
 *  use `autoApprove.model`; classifier mode uses `autoApprove.classifierModel`
 *  and falls back to the shipped Neuralwatt decision model. */
export function reviewModelSpecs(config: AutoApproveConfig = loadAutoApproveConfig()): string[] {
  if (reviewMode() === "classifier") {
    const configured = config.classifierModel;
    const specs = Array.isArray(configured) ? configured : configured ? [configured] : [];
    return specs.length > 0 ? specs : [DEFAULT_CLASSIFIER_MODEL];
  }
  const configured = config.model;
  return Array.isArray(configured) ? configured : configured ? [configured] : [];
}
