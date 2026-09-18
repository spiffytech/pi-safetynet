/**
 * popup-component.ts — runtime-agnostic review component for inferred-rule
 * proposals. Pure logic + plain-string rendering; each frontend supplies a
 * thin wrapper (key matching + TUI plumbing) for its own pi-tui flavor.
 *
 * Contract (plans/inferred-rules-design.md §7 + popup discussion):
 *  - Esc DEFERS (queue + badge stay) — never aborts the agent; nothing here
 *    gates tool calls.
 *  - Durations: session / project / global only ("once"/"turn" are vacuous
 *    for proposals — the triggering command was already approved).
 */
import type { ProfileName } from "../types.ts";
import type { InferredEngine } from "./engine.ts";
import type { PendingProposal } from "./store.ts";

export type Scope = "session" | "project" | "global";
const SCOPES: Scope[] = ["session", "project", "global"];

export type PopupKey = "escape" | "up" | "down" | "left" | "right" | "enter";

/** Colors every theme in both frontends provides. */
export type PopupColor = "accent" | "muted" | "dim" | "borderAccent" | "warning";

/** Minimal theme seam (both frontends' Theme satisfies this). */
export interface PopupTheme {
  fg(color: PopupColor, text: string): string;
  bold(text: string): string;
}

/** Truncate a line to width with an ellipsis (local, avoids importing a
 *  specific pi-tui flavor into shared code). Applied to PLAIN text before
 *  any color is wrapped around it, so ANSI codes never count toward width. */
function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return width > 1 ? s.slice(0, width - 1) + "…" : s.slice(0, width);
}

export interface InferredReviewOpts {
  modes: ProfileName[];
  /** Map raw keypress data to a logical key using the frontend's pi-tui. */
  isKey: (data: string, key: PopupKey) => boolean;
  /** Request a TUI repaint. */
  pump: () => void;
  /** Theme seam for colors (both frontends' Theme satisfies this). */
  theme: PopupTheme;
  /** Called whenever the queue size changes (badge update). */
  onQueueChange?: (remaining: number) => void;
  /** Exit the popup (defer or queue-emptied). Release + done for the caller. */
  finish: () => void;
}

export class InferredReviewComponent {
  private selected = 0;
  private scopeIdx = 0;
  private proposals: PendingProposal[];
  private engine: InferredEngine;
  private opts: InferredReviewOpts;
  private finished = false;

  constructor(engine: InferredEngine, opts: InferredReviewOpts) {
    this.engine = engine;
    this.opts = opts;
    this.proposals = engine.listProposals();
  }

  /** Idempotent exit: defer/complete once, then never again. Called by Esc,
   *  by an emptied queue, and by the harness tearing the component down
   *  (dispose) — the last path is what keeps a UI-arbiter entry from leaking
   *  when a custom component is replaced rather than finished. */
  private finishOnce(): void {
    if (this.finished) return;
    this.finished = true;
    this.opts.finish();
  }

  /** Component teardown hook (pi-tui calls this when the component is
   *  permanently removed). Releases the arbiter entry. */
  dispose(): void {
    this.finishOnce();
  }

  private get current(): PendingProposal | undefined {
    return this.proposals[this.selected];
  }

  private settle(): void {
    this.proposals.splice(this.selected, 1);
    if (this.selected >= this.proposals.length) this.selected = Math.max(0, this.proposals.length - 1);
    this.opts.onQueueChange?.(this.proposals.length);
    if (this.proposals.length === 0) this.finishOnce();
  }

  private accept(): void {
    const p = this.current;
    if (!p) return;
    this.engine.accept(p.id, SCOPES[this.scopeIdx]!, this.opts.modes);
    this.settle();
  }

  private drop(): void {
    const p = this.current;
    if (!p) return;
    this.engine.drop(p.id);
    this.settle();
  }

  /** Component.handleInput — returns void per the pi-tui contract. */
  handleInput(data: string): void {
    const isKey = (key: PopupKey) => this.opts.isKey(data, key);
    if (isKey("escape")) {
      this.finishOnce(); // defer everything — never aborts the agent
      return;
    }
    if (isKey("up")) this.selected = Math.max(0, this.selected - 1);
    else if (isKey("down")) this.selected = Math.min(this.proposals.length - 1, this.selected + 1);
    else if (isKey("left")) this.scopeIdx = (this.scopeIdx + SCOPES.length - 1) % SCOPES.length;
    else if (isKey("right")) this.scopeIdx = (this.scopeIdx + 1) % SCOPES.length;
    else if (isKey("enter")) this.accept();
    else if (data === "d" || data === "D") this.drop();
    else return; // unrecognized — no repaint needed
    this.opts.pump();
  }

  /** No-op: stateless across repaints. Satisfies omp's Component contract. */
  invalidate(): void {}

  render(width: number): string[] {
    const t = this.opts.theme;
    const border = (s: string) => t.fg("borderAccent", s);
    // Box: border chars + one space of horizontal padding inside.
    const innerW = Math.max(10, width - 2);
    const padW = innerW - 2; // usable text width (one space each side)
    const lines: string[] = [];

    /** A full content row: plain text is truncated+padded first (ANSI-safe),
     *  then colorized, then framed. */
    const row = (plain: string, colored?: (padded: string) => string) => {
      const body = truncate(plain, padW).padEnd(padW);
      return border("│") + " " + (colored ? colored(body) : body) + " " + border("│");
    };

    // Top border with embedded title. Available plain width for the title
    // is innerW - 1 (two corners + leading dash); dashes fill the rest.
    const availTitle = Math.max(1, innerW - 1);
    const fullTitle = " Inferred rule proposals ";
    const titlePlain = truncate(fullTitle, availTitle);
    const dashes = Math.max(0, availTitle - titlePlain.length);
    const titleStyled =
      titlePlain.length >= fullTitle.length
        ? border(" ") + t.fg("accent", t.bold(fullTitle.trim())) + border(" ")
        : t.fg("accent", titlePlain);
    lines.push(border("╭") + border("─") + titleStyled + border("─".repeat(dashes)) + border("╮"));

    const count = this.proposals.length;
    lines.push(row(`the agent keeps working while you review · ${count} pending`, (p) => t.fg("muted", p)));
    lines.push(row(""));

    if (count === 0) lines.push(row("Queue is empty.", (p) => t.fg("muted", p)));
    for (let i = 0; i < count; i++) {
      const p = this.proposals[i]!;
      const selected = i === this.selected;
      const markerPlain = `${i + 1}/${count}`;
      const avail = Math.max(4, padW - markerPlain.length - 2);
      const patternPlain = truncate(p.render, avail);
      const rowPlain = `${selected ? "❯" : " "} ${patternPlain}`;
      const gap = " ".repeat(Math.max(0, padW - rowPlain.length - markerPlain.length));
      const cursor = selected ? t.fg("accent", t.bold("❯")) : " ";
      const pattern = selected ? t.fg("accent", t.bold(patternPlain)) : patternPlain;
      const marker = t.fg("dim", markerPlain);
      lines.push(border("│") + " " + cursor + " " + pattern + gap + marker + " " + border("│"));
      for (const ex of p.exemplars.slice(0, 3)) {
        lines.push(row(`    observed: ${ex}`, (x) => t.fg("muted", x)));
      }
    }

    lines.push(row(""));
    // Scope selector — active scope accented, others dimmed. Only colorize
    // when the whole line fits; at tiny widths fall back to plain muted.
    const scopePlain = `Scope  ${SCOPES.map((s) => `[${s}]`).join("  ")}`;
    if (scopePlain.length <= padW) {
      const pad = " ".repeat(padW - scopePlain.length);
      const styled = SCOPES.map((s) =>
        s === SCOPES[this.scopeIdx] ? t.fg("accent", t.bold(`[${s}]`)) : t.fg("dim", `[${s}]`),
      ).join(t.fg("dim", "  "));
      lines.push(border("│") + " Scope  " + styled + pad + " " + border("│"));
    } else {
      lines.push(row(scopePlain, (p) => t.fg("muted", p)));
    }
    lines.push(
      row("enter accept · d drop · esc defer · ↑/↓ select · ←/→ scope", (p) => t.fg("dim", p)),
    );

    // Bottom border: corners + innerW dashes = innerW + 2 visible cells.
    lines.push(border("╰") + border("─".repeat(innerW)) + border("╯"));
    return lines;
  }
}
