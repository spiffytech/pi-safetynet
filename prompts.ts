import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { toDisplayPath } from "./project.ts";

// ─── Public types ───────────────────────────────────────────────────────────

export type PermissionDuration = "once" | "session" | "project" | "global" | "turn" | "timed";

/**
 * Result from the permission prompt.
 *
 * `approved` maps original item text → possibly-edited approved text.
 * The caller should create rules for the approved items using the
 * (possibly edited) text as the pattern, keyed by the original text
 * to know which check.unapproved entries are covered.
 */
export interface PermissionPromptResult {
  approved: Map<string, string>; // original → possibly-edited
  skipped: string[];
  duration: PermissionDuration;
}

export interface PermissionPromptOptions {
  permission: "bash" | "edit" | "read";
  target: string;
  unapproved?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  reason?: string | undefined;
  /** Minutes for timed approval (default 15). */
  timedApprovalMinutes?: number;
  /** True when re-prompting after rules were added but still insufficient. */
  reprompt?: boolean;
}

// ─── Internal types ────────────────────────────────────────────────────────

interface CommandListItem {
  /** Original text from the check result. */
  original: string;
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

type FocusZone = "commands" | "duration";

const MAX_DISPLAY_CHARS = 280;

function displayText(item: CommandListItem): string {
  if (item.isFile) return toDisplayPath(item.text);
  // First 280 chars of first line
  const firstNewline = item.text.indexOf("\n");
  const firstLine = firstNewline >= 0 ? item.text.slice(0, firstNewline) : item.text;
  if (firstLine.length <= MAX_DISPLAY_CHARS) return firstLine;
  return firstLine.slice(0, MAX_DISPLAY_CHARS - 1) + "…";
}

function makeItem(text: string, isFile: boolean): CommandListItem {
  return {
    original: text,
    text,
    checked: true,
    editing: false,
    isFile,
  };
}

function getDurationOptions(timedMinutes: number): DurationOption[] {
  return [
    { value: "once", label: "Once" },
    { value: "session", label: "Session" },
    { value: "project", label: "Project" },
    { value: "turn", label: "Turn" },
    { value: "timed", label: `${timedMinutes}m` },
    { value: "global", label: "Global" },
  ];
}

// ─── Internal: PermissionPromptComponent ──────────────────────────────────

class PermissionPromptComponent implements Component, Focusable {
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

  onConfirm?: (result: PermissionPromptResult) => void;
  onCancel?: () => void;

  constructor(
    items: CommandListItem[],
    durationOptions: DurationOption[],
    headerText: string,
    extraHeaderLines: string[],
    reason: string | undefined,
    theme: Theme,
  ) {
    this.items = items;
    this.durationOptions = durationOptions;
    this.headerText = headerText;
    this.extraHeaderLines = extraHeaderLines;
    this.reason = reason;
    this.theme = theme;
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

    // Help text
    {
      const help = this.focusZone === "commands"
        ? "↑↓ navigate · space toggle · enter edit · tab duration · esc deny"
        : "←→ switch · enter confirm · shift+tab commands · esc deny";
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
  }

  handleInput(data: string): void {
    // If editing, route to Input first
    if (this.focusZone === "commands" && this.selectedIndex < this.items.length) {
      const item = this.items[this.selectedIndex]!;
      if (item.editing && item.input) {
        this.handleEditInput(data, item);
        return;
      }
    }

    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }

    if (this.focusZone === "commands") {
      this.handleCommandsInput(data);
    } else {
      this.handleDurationInput(data);
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
    } else if (matchesKey(data, "shift+tab")) {
      this.focusZone = "commands";
      this.invalidate();
    } else if (matchesKey(data, Key.up)) {
      this.focusZone = "commands";
      this.selectedIndex = this.items.length - 1;
      this.invalidate();
    }
  }

  private startEdit(index: number): void {
    const item = this.items[index]!;
    if (item.editing) return;
    item.editing = true;

    if (!item.input) {
      const input = new Input();
      input.setValue(item.text);
      item.input = input;
    } else {
      item.input.setValue(item.text);
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
      // Cancel edit, restore original text
      item.text = item.original;
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

    for (const item of this.items) {
      if (item.checked) {
        approved.set(item.original, item.text);
      } else {
        skipped.push(item.original);
      }
    }

    const duration = this.durationOptions[this.selectedDuration]!.value;
    this.onConfirm?.({ approved, skipped, duration });
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
  const minutes = opts.timedApprovalMinutes ?? 15;

  // Build items
  const items: CommandListItem[] = [];

  if (isFile) {
    items.push(makeItem(opts.target, true));
  } else {
    const unapproved = opts.unapproved?.length ? opts.unapproved : [opts.target];
    for (const sub of unapproved) {
      items.push(makeItem(sub, false));
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

  const durationOptions = getDurationOptions(minutes);

  return withToolsExpanded(ctx, () =>
    ctx.ui.custom<PermissionPromptResult | null>((tui, theme, _keybindings, done) => {
      const inner = new PermissionPromptComponent(
        items,
        durationOptions,
        headerText,
        extraHeader,
        opts.reason,
        theme,
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


