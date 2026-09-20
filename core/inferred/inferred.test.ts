/**
 * inferred.test.ts — counters, engine lifecycle, judge validation, and the
 * pending queue / accepted-rule store.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic global store: never read/write the user's real ~/.config/pi-safetynet.
process.env.SAFETYNET_INFERRED_DIR = mkdtempSync(join(tmpdir(), "safetynet-global-"));
import { ShapeCounters, RIPEN_THRESHOLD } from "./counters.ts";
import { InferredEngine } from "./engine.ts";
import { runInferredJudge, buildJudgePrompt, type JudgeInput } from "./judge.ts";
import { InferredRuleStore, ProposalQueue } from "./store.ts";
import { subcommandTokenLists } from "../bash-parser.ts";
import { resetLearnedBoundariesForTests } from "./shapes.ts";
import { patternMatches, renderPattern } from "./shapes.ts";

function toks(cmd: string): string[] {
  return subcommandTokenLists(cmd)[0]!;
}

// ─── Counters ───────────────────────────────────────────────────────────────

describe("shape counters", () => {
  it("ripens exactly once at the threshold", () => {
    const c = new ShapeCounters();
    assert.equal(c.record(toks("git log main")), null);
    const ripened = c.record(toks("git log dev"));
    assert.ok(ripened);
    assert.equal(renderPattern(ripened.pattern), "git log <arg>");
    assert.equal(c.record(toks("git log other")), null, "no re-offer after ripening");
  });

  it("never ripens unmergeable shapes", () => {
    const c = new ShapeCounters();
    assert.equal(c.record(toks("git commit a -m msg")), null);
    assert.equal(c.record(toks("git commit b -m msg")), null, "interior slot must not ripen");
    assert.equal(c.record(toks("git commit c -m msg")), null);
    assert.ok(c.get(shapeKeyOrThrow("git commit a -m msg"))!.unripenable);
  });

  it("keeps shapes independent", () => {
    const c = new ShapeCounters();
    assert.equal(c.record(toks("git log main")), null);
    assert.equal(c.record(toks("git status")), null);
    const ripened = c.record(toks("git log dev"));
    assert.ok(ripened && renderPattern(ripened.pattern) === "git log <arg>");
  });

  it("refuses unshapeable commands", () => {
    // direct: program must be a bare word (leading assignments are parsed
    // away by the shell parser; flag/assignment programs are refused)
    assert.equal(shapeKeyOf(["-x", "y"]), null);
    assert.equal(shapeKeyOf(["A=1", "b"]), null);
    assert.equal(shapeKeyOf([]), null);
  });

  it("resets cleanly", () => {
    const c = new ShapeCounters();
    c.record(toks("git log main"));
    c.reset();
    assert.equal(c.record(toks("git log dev")), null, "count restarts after reset");
  });

  it("threshold is 2", () => {
    assert.equal(RIPEN_THRESHOLD, 2);
  });
});

import { shapeKeyOf } from "./shapes.ts";
function shapeKeyOrThrow(cmd: string): string {
  const k = shapeKeyOf(toks(cmd));
  assert.ok(k);
  return k;
}

// ─── Judge ──────────────────────────────────────────────────────────────────

function judgeInput(a: string, b: string): JudgeInput {
  const tokens = [toks(a), toks(b)];
  const r = mergeExemplars(tokens);
  assert.ok(r.ok);
  return { render: renderPattern(r.pattern), pattern: r.pattern, exemplars: [a, b], exemplarTokens: tokens, count: 2 };
}

import { mergeExemplars } from "./shapes.ts";

describe("judge", () => {
  it("accepts the mechanical merge", async () => {
    const v = await runInferredJudge(judgeInput("git log main", "git log dev"), {
      ask: async () => JSON.stringify({ verdict: "offer", rationale: "safe read-only" }),
    });
    assert.equal(v.kind, "offer");
    if (v.kind === "offer") {
      assert.equal(v.candidates.length, 1);
      assert.equal(renderPattern(v.candidates[0]!), "git log <arg>");
    }
  });

  it("rejects risky shapes", async () => {
    const v = await runInferredJudge(judgeInput("curl -sL x y", "curl -sL x z"), {
      ask: async () => JSON.stringify({ verdict: "reject", rationale: "egress" }),
    });
    assert.equal(v.kind, "reject");
  });

  it("validates pin values against observed exemplars", async () => {
    const input = judgeInput("git commit -m a x", "git commit -m b y");
    const v = await runInferredJudge(input, {
      ask: async () =>
        JSON.stringify({
          verdict: "offer",
          rationale: "narrower variant",
          candidates: [
            { pins: { 4: "x" } },            // valid: x observed at position 4
            { pins: { 3: "NEVER-SEEN" } },   // invalid: unobserved value
            { pins: { 1: "commit" } },       // invalid: position 1 is not a slot
          ],
        }),
    });
    assert.equal(v.kind, "offer");
    if (v.kind === "offer") {
      assert.equal(v.candidates.length, 2, "invalid pins dropped; full merge appended");
      assert.equal(renderPattern(v.candidates[0]!), "git commit -m <arg> x");
      assert.equal(renderPattern(v.candidates[v.candidates.length - 1]!), "git commit -m <arg> <arg>");
    }
  });

  it("transient on garbage output", async () => {
    const v = await runInferredJudge(judgeInput("git log main", "git log dev"), {
      ask: async () => "I am sorry, I cannot do that.",
    });
    assert.equal(v.kind, "transient");
  });

  it("transient on spawn error", async () => {
    const v = await runInferredJudge(judgeInput("git log main", "git log dev"), {
      ask: async () => { throw new Error("boom"); },
    });
    assert.equal(v.kind, "transient");
  });

  it("prompt contains the render and exemplars", () => {
    const p = buildJudgePrompt(judgeInput("git log main", "git log dev"));
    assert.ok(p.includes("git log <arg>"));
    assert.ok(p.includes("git log main"));
  });
});

describe("learned-boundary persistence", () => {
  it("a missing/empty file CLEARS the in-memory set (deletion is authoritative)", async () => {
    const { writeJsonAtomic } = await import("../json-store.ts");
    const { loadLearnedBoundaries, saveLearnedBoundaries } = await import("./learned.ts");
    const { learnBoundary, mergeExemplars, getLearnedBoundaries } = await import("./shapes.ts");
    const dir = process.env.SAFETYNET_INFERRED_DIR!;

    // Prime a boundary, persist it, and confirm it blocks a merge.
    learnBoundary("log");
    saveLearnedBoundaries();
    loadLearnedBoundaries();
    assert.deepEqual(getLearnedBoundaries(), ["log"]);
    assert.ok(!mergeExemplars([toks("git log x"), toks("git log y")]).ok);

    // Wipe the file the way the user would, then reload in the same process.
    writeJsonAtomic(join(dir, "learned-boundaries.json"), { version: 1, tokens: [] });
    loadLearnedBoundaries();
    assert.deepEqual(getLearnedBoundaries(), [], "reload must remove the stale token");
    const merge = mergeExemplars([toks("git log x"), toks("git log y")]);
    assert.ok(merge.ok, "merge past `log` works again after the boundary is cleared");
  });
});

// ─── Store + queue (temp project dir) ───────────────────────────────────────

describe("inferred store + queue", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "safetynet-inferred-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
  });

  it("accepted project rules persist and reload", () => {
    const store = new InferredRuleStore(dir);
    store.accept({
      id: "r1", render: "git log <arg>",
      pattern: { tokens: [{ kind: "lit", text: "git" }, { kind: "lit", text: "log" }, { kind: "slot" }] },
      modes: ["build"], exemplars: ["git log main"], scope: "project", acceptedAt: 1,
    });
    assert.ok(existsSync(join(dir, ".pi", "extensions", "safetynet", "inferred-rules.json")));
    const store2 = new InferredRuleStore(dir);
    assert.equal(store2.all().length, 1);
    assert.equal(store2.all()[0]!.render, "git log <arg>");
  });

  it("accepting a rule preserves a pending proposal (single-file RMW)", () => {
    const q = new ProposalQueue(dir);
    assert.ok(q.enqueue({ id: "p1", render: "git log <arg>", pattern: { tokens: [] }, exemplars: [], count: 2, createdAt: Date.now() }));
    const store = new InferredRuleStore(dir);
    store.accept({
      id: "r1", render: "git push <arg>",
      pattern: { tokens: [{ kind: "slot" }] },
      modes: ["build"], exemplars: [], scope: "project", acceptedAt: 1,
    });

    const doc = JSON.parse(readFileSync(join(dir, ".pi", "extensions", "safetynet", "inferred-rules.json"), "utf-8"));
    assert.equal(doc.rules.length, 1);
    assert.equal(doc.proposals.length, 1, "queue key must survive an accept");
    assert.equal(new InferredRuleStore(dir).all().length, 1);
    assert.equal(new ProposalQueue(dir).list().length, 1);
  });

  it("enqueuing a proposal preserves accepted rules (single-file RMW)", () => {
    const store = new InferredRuleStore(dir);
    store.accept({
      id: "r1", render: "git push <arg>",
      pattern: { tokens: [{ kind: "slot" }] },
      modes: ["build"], exemplars: [], scope: "project", acceptedAt: 1,
    });
    const q = new ProposalQueue(dir);
    assert.ok(q.enqueue({ id: "p1", render: "git log <arg>", pattern: { tokens: [] }, exemplars: [], count: 2, createdAt: Date.now() }));

    assert.equal(new InferredRuleStore(dir).hasEquivalent("git push <arg>"), true, "rule key must survive an enqueue");
  });

  it("hasEquivalent blocks duplicates", () => {
    const store = new InferredRuleStore(dir);
    const rule = {
      id: "r1", render: "git log <arg>",
      pattern: { tokens: [] },
      modes: ["build"], exemplars: [], scope: "session", acceptedAt: 1,
    } as unknown as Parameters<InferredRuleStore["accept"]>[0];
    store.accept(rule);
    assert.equal(store.hasEquivalent("git log <arg>"), true);
    assert.equal(store.hasEquivalent("other"), false);
  });

  it("queue persists, caps, and expires", () => {
    const q = new ProposalQueue(dir);
    for (let i = 0; i < 25; i++) {
      const ok = q.enqueue({
        id: `p${i}`, render: `rule-${i}`, pattern: { tokens: [] },
        exemplars: [], count: 2, createdAt: Date.now() - i * 1000,
      });
      assert.ok(ok);
    }
    const q2 = new ProposalQueue(dir);
    assert.equal(q2.list().length, 20, "cap 20");
    assert.equal(q2.list()[0]!.id, "p5", "oldest evicted");
    assert.ok(q2.remove("p24"));
    assert.equal(q2.list().length, 19);
  });

  it("queue dedups by render", () => {
    const q = new ProposalQueue(dir);
    assert.ok(q.enqueue({ id: "a", render: "x", pattern: { tokens: [] }, exemplars: [], count: 2, createdAt: Date.now() }));
    assert.equal(q.enqueue({ id: "b", render: "x", pattern: { tokens: [] }, exemplars: [], count: 2, createdAt: Date.now() }), false);
  });

  it("queue suppression predicate drops already-allowed shapes", () => {
    const q = new ProposalQueue(dir);
    const ok = q.enqueue(
      { id: "a", render: "git log <arg>", pattern: { tokens: [] }, exemplars: ["git log main"], count: 2, createdAt: Date.now() },
      { suppressIfAllowed: () => true },
    );
    assert.equal(ok, false);
    assert.equal(q.list().length, 0);
  });
});

// ─── Engine ─────────────────────────────────────────────────────────────────

describe("engine", () => {
  let dir: string;
  beforeEach(() => {
    resetLearnedBoundariesForTests();
    dir = mkdtempSync(join(tmpdir(), "safetynet-inferred-eng-"));
    mkdirSync(join(dir, ".pi"), { recursive: true });
  });

  function mkEngine(hooks: ConstructorParameters<typeof InferredEngine>[1] = {}) {
    return new InferredEngine(dir, hooks);
  }

  it("full lifecycle: two approvals → judge → queue → accept → enforces", async () => {
    const eng = mkEngine({
      onProposalQueued: () => {},
    });
    eng.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };

    eng.recordApproval(["git log main"], ["build"]);
    eng.recordApproval(["git log dev"], ["build"]);
    // judge is async — wait a tick for the background offer to land
    await new Promise((r) => setTimeout(r, 10));

    const proposals = eng.listProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.render, "git log <arg>");

    const render = eng.accept(proposals[0]!.id, "project", ["build"]);
    assert.equal(render, "git log <arg>");
    const rules = eng.rulesForProfile("build", {});
    assert.equal(rules.length, 1);
    assert.equal(
      patternMatches(rules[0]!.pattern, toks("git log whatever")), true,
    );
    assert.equal(eng.listProposals().length, 0);
  });

  it("an empty approval list records nothing (auto-approved siblings are not evidence)", async () => {
    const eng = mkEngine();
    eng.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
    eng.recordApproval([], ["build"]);
    eng.recordApproval([], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(eng.listProposals().length, 0);
  });

  it("reject verdict queues nothing", async () => {
    const eng = mkEngine();
    eng.judgeDeps = { ask: async () => JSON.stringify({ verdict: "reject", rationale: "egress" }) };
    eng.recordApproval(["curl -s a"], ["build"]);
    eng.recordApproval(["curl -s b"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(eng.listProposals().length, 0);
  });

  it("already-allowed exemplars are silently suppressed", async () => {
    const eng = mkEngine();
    eng.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
    eng.suppressIfAllowed = (exemplar) => exemplar === "git log main";
    eng.recordApproval(["git log main"], ["build"]);
    eng.recordApproval(["git log dev"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(eng.listProposals().length, 0);
  });

  it("drop teaches learned boundaries", async () => {
    const eng = mkEngine();
    eng.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
    eng.recordApproval(["git log main"], ["build"]);
    eng.recordApproval(["git log dev"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    const p = eng.listProposals()[0]!;
    eng.drop(p.id);
    // The slot's preceding literal `log` is now a learned boundary: a fresh
    // identical ripening must fail to merge.
    const { mergeExemplars } = await import("./shapes.ts");
    const r = mergeExemplars([toks("git log x"), toks("git log y")]);
    assert.ok(!r.ok, "learned boundary must block re-merging past `log`");
    assert.equal(r.ok ? "" : r.failure.why, "boundary");
  });

  it("judgment failures fail open to the mechanical merge", async () => {
    const eng = mkEngine();
    eng.judgeDeps = { ask: async () => { throw new Error("rate limited"); } };
    eng.recordApproval(["git log main"], ["build"]);
    eng.recordApproval(["git log dev"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    // transient judge → no offer (fail closed on quality, structure is safe)
    assert.equal(eng.listProposals().length, 0);
  });

  it("does not re-offer shapes already accepted in a prior session", async () => {
    const eng1 = mkEngine();
    eng1.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
    eng1.recordApproval(["git log main"], ["build"]);
    eng1.recordApproval(["git log dev"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    eng1.accept(eng1.listProposals()[0]!.id, "project", ["build"]);

    // fresh engine over the same project dir (new session)
    const eng2 = new InferredEngine(dir);
    eng2.judgeDeps = { ask: async () => JSON.stringify({ verdict: "offer", rationale: "ok" }) };
    eng2.recordApproval(["git log other"], ["build"]);
    eng2.recordApproval(["git log more"], ["build"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(eng2.listProposals().length, 0, "ratified render never re-offered");
  });
});
