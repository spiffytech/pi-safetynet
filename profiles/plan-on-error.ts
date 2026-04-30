import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

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
  const entries = ctx.sessionManager.getEntries();
  const entry = entries
    .filter(
      (e: { type: string; customType?: string }) =>
        e.type === "custom" && e.customType === "spfy:plan-on-error",
    )
    .pop() as { data?: { enabled?: boolean } } | undefined;

  if (entry?.data?.enabled !== undefined) {
    planOnErrorEnabled = entry.data.enabled;
  }
}

export function getPlanOnErrorInstruction(): string | null {
  if (!planOnErrorEnabled) return null;
  return `${MARKER}\nIf this result represents an error, use switchProfile('plan').`;
}

export function hasPlanOnErrorMarker(text: string): boolean {
  return text.includes(MARKER);
}
