import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PermissionPromptComponent,
  makeItem,
  getDurationOptions,
  type DenyEditor,
  type PermissionPromptResult,
} from "./prompts.ts";

// ─── Test fixtures ─────────────────────────────────────────────────────────

// Minimal theme stub: the component only uses theme.fg() and theme.bold().
// We avoid constructing a real Theme (which validates color values).
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as import("@earendil-works/pi-coding-agent").Theme;

const WIDTH = 80;

/** Lightweight fake of pi-tui's Editor. Records inputs; renders one line. */
class FakeEditor implements DenyEditor {
  text = "";
  inputs: string[] = [];
  invalidated = 0;
  handleInput(data: string): void {
    this.inputs.push(data);
    // Crude behaviour: printable chars append; backspace deletes; Enter/Tab/Esc
    // are not interpreted here (the component handles submit/navigation).
    if (data === "\x7f" || data === "\b") {
      this.text = this.text.slice(0, -1);
      return;
    }
    if (data === "\r" || data === "\n" || data === "\t" || data === "\x1b") return;
    if (data.startsWith("\x1b")) return; // escape sequence (arrow etc.)
    this.text += data;
  }
  render(_width: number): string[] {
    return this.text.length === 0 ? [] : [` ${this.text}`];
  }
  getText(): string {
    return this.text;
  }
  setText(t: string): void {
    this.text = t;
  }
  invalidate(): void {
    this.invalidated++;
  }
}

function makePrompt(target = "rm -rf /tmp/foo"): {
  component: PermissionPromptComponent;
  editor: FakeEditor;
} {
  const items = [makeItem(target, false)];
  const editor = new FakeEditor();
  const component = new PermissionPromptComponent(
    items,
    getDurationOptions(),
    "⚠️ bash approval required",
    [],
    undefined,
    theme,
    editor,
  );
  return { component, editor };
}

function collect(component: PermissionPromptComponent): {
  results: PermissionPromptResult[];
  cancels: { n: number };
} {
  const results: PermissionPromptResult[] = [];
  const cancels = { n: 0 };
  component.onConfirm = (r) => results.push(r);
  component.onCancel = () => { cancels.n++; };
  return { results, cancels };
}

// Raw input bytes for keys
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("PermissionPromptComponent: approval path", () => {
  it("Enter on duration emits approve result", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    // focus starts on "duration" (default zone) → Enter confirms
    c.handleInput(ENTER);
    assert.equal(spy.results.length, 1);
    assert.equal(spy.results[0]!.kind, "approve");
    if (spy.results[0]!.kind === "approve") {
      const { approved, skipped, duration } = spy.results[0]!;
      assert.equal(duration, "once"); // default selectedDuration
      assert.deepEqual(skipped, []);
      assert.equal(approved.get("rm -rf /tmp/foo"), "rm -rf /tmp/foo");
    }
  });
});

describe("PermissionPromptComponent: outer Esc aborts (when not in deny editor)", () => {
  it("Esc from duration zone calls onCancel (turn-aborting)", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(ESC);
    assert.equal(spy.cancels.n, 1);
    assert.equal(spy.results.length, 0);
  });

  it("Esc from commands zone calls onCancel", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    // Move up into commands zone, then Esc → abort
    c.handleInput(UP);
    c.handleInput(ESC);
    assert.equal(spy.cancels.n, 1);
    assert.equal(spy.results.length, 0);
  });
});

describe("PermissionPromptComponent: `d` keybind is gone", () => {
  it("pressing `d` does nothing (no result, no cancel, no zone change)", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput("d");
    assert.equal(spy.results.length, 0);
    assert.equal(spy.cancels.n, 0);
    // Render should still show the duration zone (default), not a deny editor row
    const lines = c.render(WIDTH);
    const denyHeader = lines.find((l) => l.includes("▸ deny:"));
    assert.equal(denyHeader, undefined, "deny editor must not open on `d`");
  });
});

describe("PermissionPromptComponent: deny editor (pi-ask-style)", () => {
  it("Tab from duration drops into the deny editor zone", () => {
    const { component: c } = makePrompt();
    c.handleInput(TAB); // duration → deny
    const lines = c.render(WIDTH);
    const header = lines.find((l) => l.includes("▸ deny:"));
    assert.ok(header, "deny editor header should render when focused");
    // Empty state shows the placeholder.
    const placeholder = lines.find((l) => l.includes("type a reason"));
    assert.ok(placeholder, "placeholder should show when editor is empty");
  });

  it("[Deny…] row renders when deny is not focused", () => {
    const { component: c } = makePrompt();
    const lines = c.render(WIDTH);
    const row = lines.find((l) => l.includes("[Deny…]"));
    assert.ok(row, "[Deny…] affordance row should render");
  });

  it("typing routes to the editor; Enter submits deny-with-explanation (trimmed)", () => {
    const { component: c, editor } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    for (const ch of "   why not   ") c.handleInput(ch);
    c.handleInput(ENTER);
    assert.equal(spy.results.length, 1);
    assert.deepEqual(spy.results[0], { kind: "deny", explanation: "why not" });
    assert.equal(editor.inputs.length, 13, "each char was delegated to the editor");
  });

  it("empty Enter submits plain deny (empty explanation, no abort)", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput(ENTER); // empty
    assert.equal(spy.results.length, 1);
    assert.deepEqual(spy.results[0], { kind: "deny", explanation: "" });
    assert.equal(spy.cancels.n, 0, "must not abort");
  });

  it("whitespace-only trims to empty → plain deny", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    for (const ch of "   ") c.handleInput(ch);
    c.handleInput(ENTER);
    assert.equal(spy.results.length, 1);
    assert.deepEqual(spy.results[0], { kind: "deny", explanation: "" });
  });

  it("Esc from deny zone returns to duration (does NOT abort)", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput(ESC); // back out → duration
    assert.equal(spy.cancels.n, 0, "must not abort the turn");
    assert.equal(spy.results.length, 0);
    // Now Enter on duration approves (proves we left the deny zone).
    c.handleInput(ENTER);
    assert.equal(spy.results[0]!.kind, "approve");
  });

  it("Esc then Esc: deny→duration, then duration-abort", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput(ESC); // → duration (no abort)
    assert.equal(spy.cancels.n, 0);
    c.handleInput(ESC); // → abort
    assert.equal(spy.cancels.n, 1);
    assert.equal(spy.results.length, 0);
  });

  it("empty editor: Shift+Tab navigates back to duration", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput(SHIFT_TAB); // → duration
    c.handleInput(ENTER); // approve
    assert.equal(spy.results[0]!.kind, "approve");
  });

  it("empty editor: Up navigates back to duration", () => {
    const { component: c } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput(UP); // → duration
    c.handleInput(ENTER); // approve
    assert.equal(spy.results[0]!.kind, "approve");
  });

  it("empty editor: Tab wraps to commands zone (no editor delegation)", () => {
    const { component: c, editor } = makePrompt();
    c.handleInput(TAB); // → deny
    c.handleInput(TAB); // → commands
    assert.equal(editor.inputs.length, 0, "Tab on empty editor must not be delegated");
    // commands zone Enter opens inline edit (a result is NOT emitted)
    const spy = collect(c);
    c.handleInput(ENTER);
    assert.equal(spy.results.length, 0, "Enter in commands starts editing, not approve");
  });

  it("empty editor: Down wraps to commands zone", () => {
    const { component: c, editor } = makePrompt();
    c.handleInput(TAB); // → deny
    c.handleInput(DOWN); // → commands
    assert.equal(editor.inputs.length, 0, "Down on empty editor must not be delegated");
  });

  it("non-empty editor: Tab is delegated to the editor (does not navigate away)", () => {
    const { component: c, editor } = makePrompt();
    const spy = collect(c);
    c.handleInput(TAB); // → deny
    c.handleInput("x"); // type something → non-empty
    c.handleInput(TAB); // should be delegated, not navigate
    assert.equal(editor.inputs.includes(TAB), true, "Tab delegated to editor when non-empty");
    assert.equal(spy.results.length, 0, "must not have submitted");
    // Still in deny zone: Enter now submits with the typed text.
    c.handleInput(ENTER);
    assert.equal(spy.results[0]!.kind, "deny");
    if (spy.results[0]!.kind === "deny") {
      assert.equal(spy.results[0]!.explanation, "x");
    }
  });

  it("entering the deny zone clears any prior editor text", () => {
    const { component: c, editor } = makePrompt();
    c.handleInput(TAB); // → deny, editor reset to ""
    for (const ch of "draft") c.handleInput(ch);
    assert.equal(editor.getText(), "draft");
    c.handleInput(ESC); // back to duration
    c.handleInput(TAB); // re-enter deny → should be cleared
    assert.equal(editor.getText(), "", "re-entering deny zone must reset editor text");
  });
});

describe("PermissionPromptComponent: render affordances", () => {
  it("help text mentions `tab deny` from the duration zone", () => {
    const { component: c } = makePrompt();
    const lines = c.render(WIDTH);
    const help = lines.find((l) => l.includes("tab deny"));
    assert.ok(help, "duration help should advertise `tab deny`");
  });

  it("deny-zone help mentions enter/esc", () => {
    const { component: c } = makePrompt();
    c.handleInput(TAB); // → deny
    const lines = c.render(WIDTH);
    const help = lines.find((l) => l.includes("enter deny") && l.includes("esc back"));
    assert.ok(help, "deny-zone help should mention enter/esc");
  });
});
