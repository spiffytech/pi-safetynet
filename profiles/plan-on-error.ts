import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getLatestCustomEntry } from "./index.ts";

let planOnErrorEnabled = false;

const MARKER = "[SPFY_PLAN_ON_ERROR]";

export function isPlanOnErrorEnabled(): boolean {
  return planOnErrorEnabled;
}

export function setPlanOnError(enabled: boolean, pi: ExtensionAPI): void {
  planOnErrorEnabled = enabled;
  pi.appendEntry("spfy:plan-on-error", { enabled });
}

export function togglePlanOnError(pi: ExtensionAPI): boolean {
  planOnErrorEnabled = !planOnErrorEnabled;
  pi.appendEntry("spfy:plan-on-error", { enabled: planOnErrorEnabled });
  return planOnErrorEnabled;
}

export function restorePlanOnError(ctx: ExtensionContext): void {
  const entry = getLatestCustomEntry<{ enabled?: boolean }>(ctx, "spfy:plan-on-error");
  if (entry?.enabled !== undefined) planOnErrorEnabled = entry.enabled;
}

export function getPlanOnErrorInstruction(): string | null {
  if (!planOnErrorEnabled) return null;
  return `${MARKER}\nIf this result represents an error, use switchProfile('plan').`;
}

export function hasPlanOnErrorMarker(text: string): boolean {
  return text.includes(MARKER);
}
