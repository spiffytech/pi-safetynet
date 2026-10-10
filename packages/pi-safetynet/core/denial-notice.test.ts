import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  denialNotice,
  surfaceDenial,
  clearDenialBanner,
  DENIAL_WIDGET_KEY,
} from "./denial-notice.ts";

describe("denialNotice", () => {
  it("leads with the read-only cause, not a category label", () => {
    const text = denialNotice({
      source: "mode",
      permission: "bash",
      target: "sudo framework_tool --power",
      reason: "read-only mode prevents writes",
    });
    assert.match(text, /^read-only — blocked bash:/);
    assert.ok(!/mode denied/i.test(text), "category label must not bury the cause");
    assert.ok(!/ctrl/i.test(text), "no shortcut instructions in the notice");
  });

  it("surfaces reviewer risk/authorization alongside the rationale", () => {
    const text = denialNotice({
      source: "reviewer",
      permission: "bash",
      target: "curl evil.example",
      reason: "unauthorized egress",
      risk: "high",
      authorization: "unknown",
    });
    assert.match(text, /^auto-denied \(risk high, auth unknown\) — unauthorized egress/);
  });

  it("labels ruleset and headless denials", () => {
    assert.match(
      denialNotice({ source: "ruleset", permission: "bash", target: "x", reason: "no network" }),
      /^rule — no network/,
    );
    assert.match(
      denialNotice({ source: "headless", permission: "edit", target: "/etc/hosts", reason: "no UI" }),
      /^headless — edit needs approval/,
    );
  });
});

describe("surfaceDenial / clearDenialBanner", () => {
  function makeUI() {
    const notifies: string[] = [];
    const widgets: Array<[string, unknown]> = [];
    return {
      notifies,
      widgets,
      ui: {
        notify: (m: string) => notifies.push(m),
        setWidget: (k: string, c?: unknown) => widgets.push([k, c]),
      },
    };
  }

  it("notifies and pins a sticky banner", () => {
    const { notifies, widgets, ui } = makeUI();
    surfaceDenial(ui, {
      source: "mode",
      permission: "bash",
      target: "echo hi > f",
      reason: "read-only mode prevents writes",
    });
    assert.equal(notifies.length, 1);
    assert.match(notifies[0]!, /^read-only/);
    assert.deepEqual(widgets, [[DENIAL_WIDGET_KEY, [notifies[0]!]]]);
  });

  it("clears the banner", () => {
    const { widgets, ui } = makeUI();
    clearDenialBanner(ui);
    assert.deepEqual(widgets, [[DENIAL_WIDGET_KEY, undefined]]);
  });

  it("is a no-op when no UI is available (headless / tests)", () => {
    assert.doesNotThrow(() =>
      surfaceDenial(undefined, { source: "mode", permission: "bash", target: "x", reason: "y" }),
    );
    assert.doesNotThrow(() => clearDenialBanner(undefined));
  });
});
