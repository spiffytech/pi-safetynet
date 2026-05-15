import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getLatestCustomEntry } from "./index.ts";

let planOnErrorEnabled = true;

const MARKER = "[SAFENET_PLAN_ON_ERROR]";

export function isPlanOnErrorEnabled(): boolean {
  return planOnErrorEnabled;
}

export function setPlanOnError(enabled: boolean, pi: ExtensionAPI): void {
  planOnErrorEnabled = enabled;
  pi.appendEntry("safetynet:plan-on-error", { enabled });
}

export function togglePlanOnError(pi: ExtensionAPI): boolean {
  planOnErrorEnabled = !planOnErrorEnabled;
  pi.appendEntry("safetynet:plan-on-error", { enabled: planOnErrorEnabled });
  return planOnErrorEnabled;
}

export function restorePlanOnError(ctx: ExtensionContext): void {
  const entry = getLatestCustomEntry<{ enabled: boolean }>(ctx, "safetynet:plan-on-error");
  if (entry?.data?.enabled !== undefined) planOnErrorEnabled = entry.data.enabled;
}

export function getPlanOnErrorInstruction(): string | null {
  if (!planOnErrorEnabled) return null;
  return `${MARKER}\nIf this result represents an error, tell the user that switching to plan mode with /safetynet:plan may help diagnose it.`;
}

export function hasPlanOnErrorMarker(text: string): boolean {
  return text.includes(MARKER);
}
