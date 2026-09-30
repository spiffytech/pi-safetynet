/**
 * popup.test.ts — visual contract for the inferred-review popup: a bordered,
 * themed box; ANSI-safe width consistency; selection/scope/accept/drop.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic global store: never read/write the user's real ~/.config/pi-safetynet.
process.env.SAFETYNET_INFERRED_DIR = mkdtempSync(join(tmpdir(), "safetynet-global-"));
import { InferredEngine } from "./engine.ts";
import { InferredReviewComponent, type PopupColor, type PopupTheme } from "./popup-component.ts";
import { resetLearnedBoundariesForTests } from "./shapes.ts";

/** Plain theme: colors become visible markers so tests can assert them. */
function markerTheme(): PopupTheme {
  return {
    fg: (color: PopupColor, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  };
}

/** ANSI-emitting theme to prove width math ignores escape codes. */
function ansiTheme(): PopupTheme {
  return { fg: (_c, text) => `\x1b[36m${text}\x1b[0m`, bold: (t) => `\x1b[1m${t}\x1b[0m` };
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const stripTheme = (s: string) => s.replace(/<\/?[a-zA-Z]+>/g, "");

async function makeComponent(opts: { theme?: PopupTheme; finished?: () => void; changes?: number[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "safetynet-popup-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const engine = new InferredEngine(dir);
  engine.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
  engine.recordApproval(["git log main"], ["build"]);
  engine.recordApproval(["git log dev"], ["build"]);
  engine.recordApproval(["dd if=a.img bs=4M"], ["build"]);
  engine.recordApproval(["dd if=b.iso bs=1M"], ["build"]);
  await new Promise((r) => setTimeout(r, 10));

  const component = new InferredReviewComponent(engine, {
    modes: ["build"],
    // tests feed logical key names directly as the raw data
    isKey: (data, key) => data === key,
    pump: () => {},
    theme: opts.theme ?? markerTheme(),
    ...(opts.changes ? { onQueueChange: (n) => opts.changes!.push(n) } : {}),
    finish: opts.finished ?? (() => {}),
  });
  return { engine, component };
}

describe("inferred popup render", () => {
  beforeEach(() => {
    resetLearnedBoundariesForTests();
  });

  it("draws a bordered box with a title", async () => {
    const { component } = await makeComponent();
    const lines = component.render(72).map(stripTheme);
    assert.ok(lines[0]!.startsWith("╭"), "top border");
    assert.ok(lines[lines.length - 1]!.startsWith("╰"), "bottom border");
    assert.ok(lines.every((l) => l.startsWith("│") || l.startsWith("╭") || l.startsWith("╰")));
    assert.ok(lines[0]!.includes("Inferred rule proposals"));
  });

  it("has consistent visible width across all rows (ANSI-safe)", async () => {
    const { component } = await makeComponent({ theme: ansiTheme() });
    const lines = component.render(72);
    const widths = lines.map((l) => stripAnsi(l).length);
    assert.equal(new Set(widths).size, 1, `ragged box: ${[...new Set(widths)].join(",")}`);
    assert.equal(widths[0], 72);
  });

  it("stays consistent at narrow widths without overflowing", async () => {
    const { component } = await makeComponent({ theme: ansiTheme() });
    for (const w of [24, 30, 40]) {
      const lines = component.render(w);
      const widths = lines.map((l) => stripAnsi(l).length);
      assert.equal(new Set(widths).size, 1, `ragged at width ${w}`);
      assert.ok(widths[0]! <= w, `overflow at width ${w}: ${widths[0]}`);
    }
  });

  it("colors the active scope and marks the selected row", async () => {
    const { component } = await makeComponent();
    const before = component.render(72).join("\n");
    assert.ok(before.includes("<accent><b>[session]</b></accent>"), "session accented by default");
    assert.ok(before.includes("❯"), "selection cursor present");

    component.handleInput("right");
    const after = component.render(72).join("\n");
    assert.ok(after.includes("<accent><b>[project]</b></accent>"), "scope cycled to project");
  });

  it("shows pattern and exemplars, dimmed", async () => {
    const { component } = await makeComponent();
    const text = component.render(72).join("\n");
    assert.ok(text.includes("git log <arg>"), "pattern rendered");
    assert.ok(text.includes("dd if=<arg> bs=<arg>"), "assignment slots rendered");
    assert.ok(text.includes("<muted>") && text.includes("observed: git log main"), "exemplar dimmed");
  });

  it("enter accepts the selected proposal and reports queue change", async () => {
    const changes: number[] = [];
    const { engine, component } = await makeComponent({ changes });
    assert.equal(engine.listProposals().length, 2);
    component.handleInput("enter");
    assert.equal(engine.listProposals().length, 1);
    assert.deepEqual(changes, [1]);
  });

  it("d drops without accepting", async () => {
    const { engine, component } = await makeComponent();
    const dropped = engine.listProposals()[0]!.render;
    component.handleInput("d");
    assert.equal(engine.listProposals().length, 1);
    assert.ok(!engine.allRules().some((r) => r.render === dropped), "drop must not create a rule");
  });

  it("esc finishes without touching the queue", async () => {
    let finished = 0;
    const { engine, component } = await makeComponent({ finished: () => finished++ });
    component.handleInput("escape");
    assert.equal(finished, 1);
    assert.equal(engine.listProposals().length, 2, "deferred, not dropped");
  });

  it("finishes automatically when the queue empties", async () => {
    let finished = 0;
    const { component } = await makeComponent({ finished: () => finished++ });
    component.handleInput("enter");
    component.handleInput("enter");
    assert.equal(finished, 1);
  });

  it("finish is idempotent across Esc + dispose (no double release)", async () => {
    let finished = 0;
    const { component } = await makeComponent({ finished: () => finished++ });
    component.handleInput("escape");
    component.dispose(); // harness teardown after Esc
    assert.equal(finished, 1);
  });

  it("dispose releases the UI arbiter (the leak that disabled the popup)", async () => {
    const { uiArbiter } = await import("../ui-arbiter.ts");
    let releases = 0;
    // Simulate the wrapper: acquire, then let the harness dispose the component.
    const entry = { priority: "p1" as const, dismiss: () => {} };
    assert.equal(uiArbiter.acquire(entry), true);
    const { component } = await makeComponent({
      finished: () => {
        uiArbiter.release(entry);
        releases++;
      },
    });
    component.dispose();
    assert.equal(releases, 1);
    assert.equal(uiArbiter.isShowing(), false, "arbiter freed for the next popup");
  });
});
