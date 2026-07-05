import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type Focusable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

/**
 * Minimal editor interface the prompt component needs. The real UI uses
 * pi-tui's `Editor`; tests inject a lightweight fake (the real `Editor`
 * requires a TUI instance and reads terminal rows on every input).
 */
export interface DenyEditor {
  handleInput(data: string): void;
  render(width: number): string[];
  getText(): string;
  setText(text: string): void;
  invalidate(): void;
}
import type { Theme } from "@earendil-works/pi-coding-agent";
import { toDisplayPath } from "./project.ts";

// ─── Public types ───────────────────────────────────────────────────────────

export type PermissionDuration = "once" | "session" | "project" | "global" | "turn";

/**
 * Result from the permission prompt.
 *
 * `approved` maps original item text → possibly-edited approved text.
 * The caller should create rules for the approved items using the
 * (possibly edited) text as the pattern, keyed by the original text
 * to know which check.unapproved entries are covered.
 */
/**
 * Result from the permission prompt.
 *
 * - `approve`: the user accepted one or more items, mapping each original item
 *   text → possibly-edited approved text. The caller should create rules for the
 *   approved items using the (possibly edited) text as the pattern, keyed by
 *   the original text to know which check.unapproved entries are covered.
 * - `deny`: the user rejected this call with a typed explanation. The caller
 *   should surface the explanation to the model WITHOUT aborting the turn.
 */
export type PermissionPromptResult =
  | { kind: "approve"; approved: Map<string, string>; skipped: string[]; skippedDisplay: string[]; duration: PermissionDuration }
  | { kind: "deny"; explanation: string };

export interface PermissionPromptOptions {
  permission: "bash" | "edit" | "read";
  target: string;
  unapproved?: string[];
  /** Display form of each unapproved subcommand, preserving original quoting.
   *  Parallel to `unapproved` (same length/order).  When present, the
   *  prompt shows the display form and uses the canonical `unapproved`
   *  entry as the rule-pattern key (unless the user edits the item). */
  unapprovedDisplay?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  reason?: string | undefined;
  /** True when re-prompting after rules were added but still insufficient. */
  reprompt?: boolean;
}

// ─── Internal types ────────────────────────────────────────────────────────

interface CommandListItem {
  /** Canonical text — the de-quoted form used for rule pattern generation
   *  and as the stable identity of this item (keying). */
  original: string;
  /** Pristine display text (immutable).  When the user has not edited
   *  `text`, the approved rule pattern is `original` (canonical), preserving
   *  approve-once-reuse semantics. */
  display: string;
  /** Current (possibly edited) text. */
  text: string;
  /** Whether this item is checked (default true). */
  checked: boolean;
  /** Whether we're inline-editing this item. */
  editing: boolean;
  /** Lazily-created Input for inline editing. */
  input?: Input;
  /** True when this item represents a file path (for display). */
  isFile: boolean;
}

interface DurationOption {
  value: PermissionDuration;
  label: string;
}

type FocusZone = "commands" | "duration" | "deny";

const MAX_DISPLAY_CHARS = 280;

function displayText(item: CommandListItem): string {
  if (item.isFile) return toDisplayPath(item.text);
  // First 280 chars of first line
  const firstNewline = item.text.indexOf("\n");
  const firstLine = firstNewline >= 0 ? item.text.slice(0, firstNewline) : item.text;
  if (firstLine.length <= MAX_DISPLAY_CHARS) return firstLine;
  return firstLine.slice(0, MAX_DISPLAY_CHARS - 1) + "…";
}

// Regexes for stripping pi-tui Editor's own top/bottom border lines
// (ported from pi-ask's getEditorContentLines) so the widget inlines cleanly.
const EDITOR_BORDER_PATTERN = /^[┌┐└┘─]+$/;
const EDITOR_SCROLL_BORDER_PATTERN = /^─── [↑↓] \d+ more ─*$/;

function isEditorBorderLine(line: string): boolean {
  // Strip ANSI escape sequences before matching border glyphs.
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  return EDITOR_BORDER_PATTERN.test(stripped) || EDITOR_SCROLL_BORDER_PATTERN.test(stripped);
}

function getEditorContentLines(editorLines: string[]): string[] {
  if (editorLines.length <= 2) return editorLines;
  // Drop the first line and the first trailing border line.
  const contentLines = editorLines.slice(1);
  const trailingBorderIndex = contentLines.findIndex(isEditorBorderLine);
  if (trailingBorderIndex === -1) return contentLines;
  return contentLines.filter((_, i) => i !== trailingBorderIndex);
}

export function makeItem(text: string, isFile: boolean, display?: string): CommandListItem {
  const displayText = display ?? text;
  return {
    original: text,
    display: displayText,
    text: displayText,
    checked: true,
    editing: false,
    isFile,
  };
}

export function getDurationOptions(): DurationOption[] {
  return [
    { value: "once", label: "Once" },
    { value: "session", label: "Session" },
    { value: "project", label: "Project" },
    { value: "turn", label: "Turn" },
    { value: "global", label: "Global" },
  ];
}

// ─── Internal: PermissionPromptComponent ──────────────────────────────────

export class PermissionPromptComponent implements Component, Focusable {
  focused: boolean = false;

  private items: CommandListItem[];
  private durationOptions: DurationOption[];
  private headerText: string;
  private extraHeaderLines: string[];
  private reason: string | undefined;
  private selectedIndex = 0;
  private selectedDuration = 0; // default: Once
  private focusZone: FocusZone = "duration";
  private theme: Theme;
  private cachedWidth: number | undefined = undefined;
  private cachedLines: string[] | undefined = undefined;
  private denyEditor: DenyEditor;
  onConfirm?: (result: PermissionPromptResult) => void;
  onCancel?: () => void;

  constructor(
    items: CommandListItem[],
    durationOptions: DurationOption[],
    headerText: string,
    extraHeaderLines: string[],
    reason: string | undefined,
    theme: Theme,
    denyEditor: DenyEditor,
  ) {
    this.items = items;
    this.durationOptions = durationOptions;
    this.headerText = headerText;
    this.extraHeaderLines = extraHeaderLines;
    this.reason = reason;
    this.theme = theme;
    this.denyEditor = denyEditor;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const innerW = width - 2; // leave room for left/right border padding

    // Header
    lines.push(this.theme.fg("warning", truncateToWidth(this.headerText, innerW)));
    for (const h of this.extraHeaderLines) {
      lines.push(this.theme.fg("muted", " " + truncateToWidth(h, innerW - 1)));
    }
    lines.push("");

    // Command items
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      const isActive = this.focusZone === "commands" && i === this.selectedIndex;

      if (item.editing && item.input) {
        const inputLines = item.input.render(innerW - 4);
        for (let j = 0; j < inputLines.length; j++) {
          const il = inputLines[j]!;
          if (j === 0) {
            lines.push(" > " + il);
          } else {
            lines.push("   " + il);
          }
        }
      } else {
        const checkbox = item.checked ? "[X]" : "[ ]";
        const cursor = isActive ? "▸" : " ";
        const dt = displayText(item);
        const line = `${cursor}${checkbox} ${truncateToWidth(dt, innerW - 6)}`;
        lines.push(isActive ? this.theme.fg("accent", line) : line);
      }
    }

    lines.push("");

    // Reason
    if (this.reason) {
      lines.push(this.theme.fg("muted", " " + truncateToWidth(`Reason: ${this.reason}`, innerW - 1)));
      lines.push("");
    }

    // Duration selector
    {
      const parts: string[] = [];
      for (let i = 0; i < this.durationOptions.length; i++) {
        const opt = this.durationOptions[i]!;
        const isActive = this.focusZone === "duration" && i === this.selectedDuration;
        if (isActive) {
          parts.push(this.theme.fg("accent", this.theme.bold(`[${opt.label}]`)));
        } else {
          parts.push(` ${opt.label} `);
        }
      }
      lines.push(" " + parts.join("  "));
    }

    // Deny affordance: a tab-reachable [Deny…] row. When focused, drops
    // into an expanding editor (pi-ask-style). Empty submit = plain deny;
    // submit with text = deny-with-explanation.
    {
      lines.push("");
      if (this.focusZone === "deny") {
        const text = this.denyEditor.getText();
        const isEmpty = text.length === 0;
        lines.push(this.theme.fg("accent", " ▸ deny:"));
        const editorLines = this.denyEditor.render(innerW - 4);
        const content = getEditorContentLines(editorLines);
        if (isEmpty) {
          lines.push(this.theme.fg("muted", "   type a reason, or Enter to deny"));
        } else {
          for (const el of content) lines.push("   " + el);
        }
      } else {
        lines.push("  [Deny…]");
      }
    }

    // Help text
    {
      const help = this.focusZone === "deny"
        ? "enter deny (empty = no reason) · esc back · shift+tab duration"
        : this.focusZone === "commands"
          ? "↑↓ navigate · space toggle · enter edit · tab duration · esc deny"
          : "←→ switch · enter confirm · tab deny · shift+tab commands · esc deny";
      lines.push(this.theme.fg("dim", " " + truncateToWidth(help, innerW - 1)));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    for (const item of this.items) {
      if (item.input) item.input.invalidate();
    }
    this.denyEditor.invalidate();
  }

  handleInput(data: string): void {
    // If editing a command, route to its inline Input first.
    if (this.focusZone === "commands" && this.selectedIndex < this.items.length) {
      const item = this.items[this.selectedIndex]!;
      if (item.editing && item.input) {
        this.handleEditInput(data, item);
        return;
      }
    }

    // Esc: in the deny editor zone, back out to duration (no abort).
    // Everywhere else, Esc aborts the turn.
    if (matchesKey(data, Key.escape)) {
      if (this.focusZone === "deny") {
        this.focusZone = "duration";
        this.invalidate();
      } else {
        this.onCancel?.();
      }
      return;
    }

    if (this.focusZone === "commands") {
      this.handleCommandsInput(data);
    } else if (this.focusZone === "duration") {
      this.handleDurationInput(data);
    } else {
      this.handleDenyEditorInput(data);
    }
  }

  private handleCommandsInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.selectedIndex < this.items.length - 1) {
        this.selectedIndex++;
        this.invalidate();
      } else {
        // Tab into duration
        this.focusZone = "duration";
        this.invalidate();
      }
    } else if (matchesKey(data, Key.space)) {
      const item = this.items[this.selectedIndex]!;
      item.checked = !item.checked;
      this.invalidate();
    } else if (matchesKey(data, Key.enter)) {
      this.startEdit(this.selectedIndex);
    } else if (matchesKey(data, Key.tab)) {
      this.focusZone = "duration";
      this.invalidate();
    }
  }

  private handleDurationInput(data: string): void {
    if (matchesKey(data, Key.left)) {
      if (this.selectedDuration > 0) {
        this.selectedDuration--;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.right)) {
      if (this.selectedDuration < this.durationOptions.length - 1) {
        this.selectedDuration++;
        this.invalidate();
      }
    } else if (matchesKey(data, Key.enter)) {
      this.confirm();
    } else if (matchesKey(data, Key.tab)) {
      // Drop into the deny editor row.
      this.focusZone = "deny";
      this.denyEditor.setText("");
      this.invalidate();
    } else if (matchesKey(data, "shift+tab")) {
      this.focusZone = "commands";
      this.invalidate();
    } else if (matchesKey(data, Key.up)) {
      this.focusZone = "commands";
      this.selectedIndex = this.items.length - 1;
      this.invalidate();
    }
  }

  // Deny editor zone: an expanding textbox (pi-ask-style).
  //  - Empty editor: Tab/Shift+Tab/arrows navigate away; Enter submits plain deny.
  //  - Non-empty: Tab/arrows delegated to the editor; Enter submits deny-with-explanation.
  //  - Whitespace-only trims to empty and submits as plain deny.
  private handleDenyEditorInput(data: string): void {
    const isEmpty = this.denyEditor.getText().length === 0;
    if (matchesKey(data, Key.enter)) {
      const explanation = this.denyEditor.getText().trim();
      this.onConfirm?.({ kind: "deny", explanation });
      return;
    }
    if (isEmpty) {
      if (matchesKey(data, "shift+tab") || matchesKey(data, Key.up)) {
        this.focusZone = "duration";
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
        this.focusZone = "commands";
        this.selectedIndex = 0;
        this.invalidate();
        return;
      }
    }
    // Delegate to the editor (typing, cursor movement, etc).
    this.denyEditor.handleInput(data);
    this.invalidate();
  }

  private startEdit(index: number): void {
    const item = this.items[index]!;
    if (item.editing) return;
    item.editing = true;

    const editValue = item.isFile ? toDisplayPath(item.text) : item.text;

    if (!item.input) {
      const input = new Input();
      input.setValue(editValue);
      (input as any).cursor = editValue.length;
      item.input = input;
    } else {
      item.input.setValue(editValue);
      (item.input as any).cursor = editValue.length;
    }
    this.invalidate();
  }

  private finishEdit(index: number, confirm: boolean): void {
    const item = this.items[index]!;
    if (!item.editing) return;

    if (confirm && item.input) {
      const newValue = item.input.getValue().trim();
      if (newValue.length > 0) {
        item.text = newValue;
      }
    }
    // On cancel, item.text retains its pre-edit value

    item.editing = false;
    this.invalidate();
  }

  private handleEditInput(data: string, item: CommandListItem): void {
    if (matchesKey(data, Key.enter)) {
      this.finishEdit(this.selectedIndex, true);
    } else if (matchesKey(data, Key.escape)) {
      // Cancel edit, restore display text (what we show by default)
      item.text = item.display;
      item.editing = false;
      this.invalidate();
    } else {
      item.input!.handleInput(data);
      this.invalidate();
    }
  }


  private confirm(): void {
    const approved = new Map<string, string>();
    const skipped: string[] = [];
    const skippedDisplay: string[] = [];

    for (const item of this.items) {
      if (item.checked) {
        // Unedited approval → use the canonical original as the rule
        // pattern (preserves approve-once-reuse across quote styles).
        // Edited approval → use the user's text.
        const pattern = item.text === item.display ? item.original : item.text;
        approved.set(item.original, pattern);
      } else {
        skipped.push(item.original);
        skippedDisplay.push(item.display);
      }
    }

    const duration = this.durationOptions[this.selectedDuration]!.value;
    this.onConfirm?.({ kind: "approve", approved, skipped, skippedDisplay, duration });
  }
}

// ─── Wrapper: adds DynamicBorder around PermissionPromptComponent ────────

class BorderedPermissionPrompt implements Component, Focusable {
  focused: boolean = false;
  private inner: PermissionPromptComponent;
  private theme: Theme;

  constructor(inner: PermissionPromptComponent, theme: Theme) {
    this.inner = inner;
    this.theme = theme;
  }

  private border = new DynamicBorder((s: string) => this.theme.fg("borderAccent", s));

  render(width: number): string[] {
    const innerLines = this.inner.render(width - 2);
    const lines: string[] = [];

    // Top border
    lines.push(...this.border.render(width));

    for (const line of innerLines) {
      // Pad line to fill inner width, then add side borders
      const padNeeded = Math.max(0, (width - 2) - visibleWidth(line));
      const padded = line + " ".repeat(padNeeded);
      lines.push(
        this.theme.fg("borderAccent", "│") + padded + this.theme.fg("borderAccent", "│"),
      );
    }

    // Bottom border
    lines.push(...this.border.render(width));

    return lines;
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }
}

// ─── Public: showPermissionPrompt ────────────────────────────────────────

async function withToolsExpanded<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
  const wasExpanded = ctx.ui.getToolsExpanded();
  ctx.ui.setToolsExpanded(true);
  try {
    return await fn();
  } finally {
    ctx.ui.setToolsExpanded(wasExpanded);
  }
}

export async function showPermissionPrompt(
  ctx: ExtensionContext,
  opts: PermissionPromptOptions,
): Promise<PermissionPromptResult | null> {
  if (!ctx.hasUI) return null;

  const isFile = opts.permission === "read" || opts.permission === "edit";

  // Build items
  const items: CommandListItem[] = [];

  if (isFile) {
    items.push(makeItem(opts.target, true));
  } else {
    const unapproved = opts.unapproved?.length ? opts.unapproved : [opts.target];
    const unapprovedDisplay = opts.unapprovedDisplay?.length ? opts.unapprovedDisplay : [];
    for (let i = 0; i < unapproved.length; i++) {
      const sub = unapproved[i]!;
      const display = unapprovedDisplay[i];
      items.push(makeItem(sub, false, display));
    }
  }

  // Redirect targets
  if (opts.redirectTargets?.length) {
    for (const rt of opts.redirectTargets) {
      items.push(makeItem(rt.path, true));
    }
  }

  const extraHeader: string[] = [];
  if (opts.reprompt) {
    extraHeader.push("ℹ️ Rules were added but still insufficient — additional approval needed.");
  }

  const headerText = isFile
    ? `⚠️ ${opts.permission} approval required`
    : "⚠️ bash approval required";

  const durationOptions = getDurationOptions();

  return withToolsExpanded(ctx, () =>
    ctx.ui.custom<PermissionPromptResult | null>((tui, theme, _keybindings, done) => {
      const denyEditor = new Editor(tui, {
        borderColor: (s: string) => theme.fg("accent", s),
        selectList: {
          description: (s: string) => theme.fg("muted", s),
          noMatch: (s: string) => theme.fg("warning", s),
          scrollInfo: (s: string) => theme.fg("dim", s),
          selectedPrefix: (s: string) => theme.fg("accent", s),
          selectedText: (s: string) => theme.fg("accent", s),
        },
      });
      // We bind submission ourselves (Enter on the editor row submits the
      // whole buffer); the editor's native Enter behaviour is disabled.
      denyEditor.disableSubmit = true;
      const inner = new PermissionPromptComponent(
        items,
        durationOptions,
        headerText,
        extraHeader,
        opts.reason,
        theme,
        denyEditor,
      );

      inner.onConfirm = (result) => done(result);
      inner.onCancel = () => done(null);

      const wrapper = new BorderedPermissionPrompt(inner, theme);

      // Propagate Focusable
      Object.defineProperty(wrapper, "focused", {
        get: () => inner.focused,
        set: (v: boolean) => { inner.focused = v; },
        configurable: true,
        enumerable: true,
      });

      // Patch handleInput to also call tui.requestRender
      const origHandleInput = wrapper.handleInput.bind(wrapper);
      wrapper.handleInput = (data: string) => {
        origHandleInput(data);
        tui.requestRender();
      };

      return wrapper;
    }),
  );
}

// ─── Public: showRulesEditor ────────────────────────────────────────────────
// (Kept for potential future use; no longer called from resolvePermission.)

export async function showRulesEditor(
  ctx: ExtensionContext,
  unapproved: string[],
  isFilePaths: boolean = false,
): Promise<{ patterns: string[]; persist: "session" | "persisted" } | null> {
  if (!ctx.hasUI) return null;

  const displayItems = isFilePaths
    ? unapproved.map((p) => toDisplayPath(p))
    : unapproved;
  const defaultText = displayItems.join("\n");
  const result = await withToolsExpanded(ctx, () =>
    ctx.ui.editor(
      "Edit rules (one per line, use * as wildcard):",
      defaultText,
    ),
  );

  if (result === undefined || result === null || result.trim().length === 0) return null;

  const patterns = result
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (patterns.length === 0) return null;

  const persist = await withToolsExpanded(ctx, () =>
    ctx.ui.select(
      "Save rules to:",
      ["This session only", "Project"],
    )
  );

  if (persist === undefined) return null;

  return {
    patterns,
    persist: persist.startsWith("Project") ? "persisted" : "session",
  };
}


