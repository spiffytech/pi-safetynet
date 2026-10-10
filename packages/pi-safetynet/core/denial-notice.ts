/**
 * denial-notice.ts — the user-facing one-liner for an auto-denial.
 *
 * Distinct from `denialMessage` (pipeline.ts), which is what the *model* sees
 * on a blocked call: that carries recovery guidance. This is the TUI notice,
 * so it leads with the cause — the first token is the thing the user acts on
 * ("read-only", "auto-denied", "rule", "headless"), not a category label that
 * buries it. Pure, no harness imports.
 */

export type DenialSource = "reviewer" | "ruleset" | "headless" | "mode";

/** Widget key for the sticky latest-denial banner (see pipelines). */
export const DENIAL_WIDGET_KEY = "safetynet-denial";

/** Notify severity per source: a mode/ruleset block is a policy decision, a
 *  reviewer deny is a judgment call, headless is a limitation. */
export const DENIAL_NOTICE_LEVEL: Record<DenialSource, "warning" | "error" | "info"> = {
  reviewer: "warning",
  ruleset: "warning",
  headless: "warning",
  mode: "warning",
};

/** Minimal UI surface a denial is reported to. Both the pi and omp
 *  ExtensionContext.ui satisfy it; tests can pass undefined. */
export interface DenialUI {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWidget(key: string, content?: unknown, opts?: unknown): void;
}

/** Report a denial to the user: a toast that leads with the cause, plus a
 *  sticky banner so a transient toast isn't the only chance to see it. The
 *  banner persists until the next successful allow (or the next denial). */
export function surfaceDenial(ui: DenialUI | undefined, notice: DenialNoticeOpts): void {
  if (!ui) return;
  const text = denialNotice(notice);
  ui.notify(text, DENIAL_NOTICE_LEVEL[notice.source]);
  ui.setWidget?.(DENIAL_WIDGET_KEY, [text], { placement: "belowEditor" });
}

/** Clear the sticky denial banner (called once an action is allowed again). */
export function clearDenialBanner(ui: DenialUI | undefined): void {
  ui?.setWidget?.(DENIAL_WIDGET_KEY, undefined);
}

export interface DenialNoticeOpts {
  source: DenialSource;
  permission: "bash" | "read" | "edit";
  target: string;
  reason: string;
  /** Reviewer verdict fields, when source === "reviewer". */
  risk?: string;
  authorization?: string;
}

/** Build the user-facing denial notice. See file header for the format rule. */
export function denialNotice(opts: DenialNoticeOpts): string {
  const { permission, target, reason } = opts;
  switch (opts.source) {
    case "mode":
      return `read-only — blocked ${permission}: ${target}`;
    case "headless":
      return `headless — ${permission} needs approval: ${target}`;
    case "reviewer": {
      const verdict =
        opts.risk && opts.authorization
          ? ` (risk ${opts.risk}, auth ${opts.authorization})`
          : "";
      return `auto-denied${verdict} — ${reason}`;
    }
    case "ruleset":
      return `rule — ${reason}`;
  }
}
