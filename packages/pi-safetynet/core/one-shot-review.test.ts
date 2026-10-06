/**
 * one-shot-review.test.ts — the active review methodology: one model
 * completion per review. Covers verdict extraction, failure mapping, the
 * single-request quota guarantee, methodology selection, and the review ledger.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnOneShotReviewer,
  pickReviewSpawn,
  extractJsonVerdict,
} from "./one-shot-review.ts";
import { runPermissionReview } from "./reviewer-state.ts";
import { setReviewLogEnabled } from "./debug-log.ts";
import { SUBMIT_VERDICT_TOOL_NAME, ONE_SHOT_ADDENDUM } from "./reviewer-prompt.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const VERDICT = {
  risk_level: "low",
  user_authorization: "high",
  outcome: "allow",
  rationale: "user asked for exactly this",
};

function registryWith(response: unknown | (() => unknown)) {
  const calls: Array<{ model: unknown; context: any; options: any }> = [];
  return {
    calls,
    registry: {
      getAll: () => [{ id: "prov/test-model", provider: "prov" }],
      find: (provider: string, id: string) => ({ id, provider, api: "openai-completions" }),
      completeSimple: async (model: unknown, context: unknown, options: unknown) => {
        calls.push({ model, context, options });
        return typeof response === "function" ? (response as () => unknown)() : response;
      },
    },
  };
}

function spawnOpts(registry: unknown, overrides: Record<string, unknown> = {}) {
  return {
    taskType: "explore" as const,
    prompt: "## Project root\n/tmp\n\n## Transcript\n[0] user: run the thing\n\n## Planned action\n{}",
    systemPrompt: "POLICY TEXT",
    parentCtx: { sessionManager: { getEntries: () => [] }, modelRegistry: registry },
    cwd: "/tmp",
    model: { id: "prov/test-model", provider: "prov", api: "openai-completions" },
    timeoutMs: 5_000,
    ...overrides,
  } as any;
}

const toolCallMsg = (args: unknown) => ({
  content: [{ type: "toolCall", name: SUBMIT_VERDICT_TOOL_NAME, arguments: args }],
  stopReason: "stop",
  usage: { input: 100, output: 20 },
});

const textMsg = (text: string) => ({
  content: [{ type: "text", text }],
  stopReason: "stop",
});

// ─── extractJsonVerdict ────────────────────────────────────────────────────

describe("extractJsonVerdict", () => {
  it("reads JSON out of a fenced block", () => {
    const out = extractJsonVerdict("here you go:\n```json\n{\"outcome\": \"deny\"}\n```\ndone");
    assert.deepEqual(out, { outcome: "deny" });
  });

  it("reads bare JSON out of prose", () => {
    const out = extractJsonVerdict("Verdict: {\"outcome\": \"allow\"} — end");
    assert.deepEqual(out, { outcome: "allow" });
  });

  it("returns undefined for prose and for non-object JSON", () => {
    assert.equal(extractJsonVerdict("I would rather not decide."), undefined);
    assert.equal(extractJsonVerdict("42"), undefined);
    assert.equal(extractJsonVerdict("{not json}"), undefined);
  });
});

// ─── spawnOneShotReviewer ──────────────────────────────────────────────────

describe("spawnOneShotReviewer", () => {
  it("makes exactly ONE model request and returns the tool-call arguments as the verdict", async () => {
    const { registry, calls } = registryWith(toolCallMsg(VERDICT));
    const result = await spawnOneShotReviewer(spawnOpts(registry));

    assert.equal(calls.length, 1, "one completion per review — the quota guarantee");
    const { context, options } = calls[0]!;
    assert.equal(context.messages.length, 1, "single-turn request, no transcript loop");
    assert.equal(context.messages[0].role, "user");
    assert.match(context.systemPrompt, /POLICY TEXT/);
    assert.match(context.systemPrompt, /## One-shot mode/);
    assert.equal(context.tools[0].name, SUBMIT_VERDICT_TOOL_NAME);
    assert.equal(context.tools[0].constrainedSampling.type, "json_schema");
    assert.equal(options.maxTokens, 2048, "output stays bounded");
    assert.equal(options.reasoning, "minimal", "no thinking budget burned on a 4-field verdict");

    assert.deepEqual(result.details.verdict, VERDICT);
    assert.equal(result.details.turnCount, 1);
    assert.deepEqual(result.details.activities, [SUBMIT_VERDICT_TOOL_NAME]);
    assert.deepEqual(result.details.usage, { input: 100, output: 20 });
  });

  it("adds the one-shot addendum to whatever system prompt it is given", async () => {
    const { registry, calls } = registryWith(toolCallMsg(VERDICT));
    await spawnOneShotReviewer(spawnOpts(registry));
    assert.ok(calls[0]!.context.systemPrompt.includes(ONE_SHOT_ADDENDUM));
  });

  it("falls back to a JSON verdict written as prose", async () => {
    const { registry } = registryWith(textMsg(`\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``));
    const result = await spawnOneShotReviewer(spawnOpts(registry));
    assert.deepEqual(result.details.verdict, VERDICT);
    assert.deepEqual(result.details.activities, []);
  });

  it("reports no verdict when the model answers with prose only", async () => {
    const { registry } = registryWith(textMsg("Let me think... no."));
    const result = await spawnOneShotReviewer(spawnOpts(registry));
    assert.equal(result.details.verdict, undefined);
    assert.equal(result.details.error, undefined);
  });

  it("maps a provider error to details.error", async () => {
    const { registry } = registryWith({ content: [], stopReason: "error", errorMessage: "429 rate limited" });
    const result = await spawnOneShotReviewer(spawnOpts(registry));
    assert.equal(result.details.error, "429 rate limited");
  });

  it("maps an abort to details.aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const registry = {
      getAll: () => [],
      completeSimple: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    };
    const result = await spawnOneShotReviewer(spawnOpts(registry, { signal: ctl.signal }));
    assert.equal(result.details.aborted, true);
    assert.equal(result.details.error, undefined);
  });

  it("maps a blown deadline to details.hitTimeout", async () => {
    const registry = {
      getAll: () => [],
      completeSimple: () => new Promise(() => {}),
    };
    const result = await spawnOneShotReviewer(spawnOpts(registry, { timeoutMs: 25 }));
    assert.equal(result.details.hitTimeout, true);
    assert.equal(result.details.error, undefined);
  });

  it("reports a usable error when no registry or model is available", async () => {
    const result = await spawnOneShotReviewer(spawnOpts(undefined, { model: undefined }));
    assert.match(String(result.details.error), /no model registry/);
    assert.equal(result.details.turnCount, 1);
  });

  it("reports a usable error when the registry cannot complete requests", async () => {
    const result = await spawnOneShotReviewer(
      spawnOpts({ getAll: () => [] }, { model: { id: "m", provider: "p", api: "openai-completions" } }),
    );
    assert.match(String(result.details.error), /no completion entry point/);
  });

  it("repairs a bare {id, provider} model through the registry", async () => {
    const { registry, calls } = registryWith(toolCallMsg(VERDICT));
    const result = await spawnOneShotReviewer(
      spawnOpts(registry, { model: { id: "prov/test-model", provider: "prov" } }),
    );
    assert.deepEqual(calls[0]!.model, { id: "prov/test-model", provider: "prov", api: "openai-completions" });
    assert.deepEqual(result.details.verdict, VERDICT);
  });

  it("falls back to the parent session's model when the chain spec is unresolvable", async () => {
    const { registry, calls } = registryWith(toolCallMsg(VERDICT));
    const parentModel = { id: "prov/parent", provider: "prov", api: "openai-completions" };
    await spawnOneShotReviewer(
      spawnOpts(registry, {
        model: undefined,
        parentCtx: {
          sessionManager: { getEntries: () => [] },
          modelRegistry: registry,
          model: parentModel,
        },
      }),
    );
    assert.deepEqual(calls[0]!.model, parentModel);
  });
});

// ─── Methodology selection ─────────────────────────────────────────────────

describe("pickReviewSpawn", () => {
  const injected = async () => ({ content: [], details: {} }) as any;
  const sessionSpawn = async () => ({ content: [], details: {} }) as any;

  afterEach(() => {
    delete process.env.SAFETYNET_REVIEW_MODE;
  });

  it("defaults to the one-shot reviewer", () => {
    assert.equal(pickReviewSpawn(undefined, sessionSpawn), spawnOneShotReviewer);
  });

  it("lets an injected spawn win (test seam / explicit override)", () => {
    process.env.SAFETYNET_REVIEW_MODE = "session";
    assert.equal(pickReviewSpawn(injected, sessionSpawn), injected);
  });

  it("reactivates the session reviewer via SAFETYNET_REVIEW_MODE=session", () => {
    process.env.SAFETYNET_REVIEW_MODE = "session";
    assert.equal(pickReviewSpawn(undefined, sessionSpawn), sessionSpawn);
  });

  it("keeps one-shot under SAFETYNET_REVIEW_MODE=one-shot", () => {
    process.env.SAFETYNET_REVIEW_MODE = "one-shot";
    assert.equal(pickReviewSpawn(undefined, sessionSpawn), spawnOneShotReviewer);
  });
});

// ─── Review ledger ─────────────────────────────────────────────────────────

describe("review ledger (reviews.jsonl)", () => {
  const TMP_HOME = join(process.cwd(), ".test-tmp-home-review-ledger");
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = TMP_HOME;
    setReviewLogEnabled(true);
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
    mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
  });

  afterEach(() => {
    setReviewLogEnabled(false);
    process.env.HOME = originalHome;
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  });

  it("records one JSONL line per review: mode, verdict, latency, usage", async () => {
    const verdict = await runPermissionReview(
      {
        permission: "bash",
        target: "echo hi",
        check: { action: "ask" },
        cwd: "/tmp",
        parentCtx: { sessionManager: { getEntries: () => [] } } as any,
        profile: "build",
        timeoutMs: 1_000,
        model: "prov/test-model",
      } as any,
      {
        spawn: (async () => ({
          content: [{ type: "text" as const, text: "" }],
          details: {
            verdict: VERDICT,
            turnCount: 1,
            activities: [SUBMIT_VERDICT_TOOL_NAME],
            usage: { input: 100, output: 20 },
          },
        })) as any,
      },
    );
    assert.equal(verdict.kind, "assessment");

    const ledgerPath = join(TMP_HOME, ".cache", "pi-safetynet", "reviews.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!);
    assert.equal(rec.mode, "one-shot", "ledger records which methodology decided");
    assert.equal(rec.kind, "assessment");
    assert.equal(rec.outcome, "allow");
    assert.equal(rec.risk, "low");
    assert.equal(rec.auth, "high");
    assert.equal(rec.turns, 1);
    assert.deepEqual(rec.usage, { input: 100, output: 20 });
    assert.equal(rec.permission, "bash");
  });

  it("records non-assessment outcomes too", async () => {
    await runPermissionReview(
      {
        permission: "bash",
        target: "echo hi",
        check: { action: "ask" },
        cwd: "/tmp",
        parentCtx: { sessionManager: { getEntries: () => [] } } as any,
        profile: "build",
        timeoutMs: 1_000,
        model: "prov/test-model",
      } as any,
      {
        spawn: (async () => ({ content: [{ type: "text" as const, text: "" }], details: { hitTimeout: true } })) as any,
      },
    );
    const ledgerPath = join(TMP_HOME, ".cache", "pi-safetynet", "reviews.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!);
    assert.equal(rec.kind, "transient");
    assert.equal(rec.outcome, undefined);
    assert.match(rec.message, /timed out/);
  });
});

// ─── Config: reviewMode parsing ────────────────────────────────────────────

describe("autoApprove.reviewMode config", () => {
  const TMP_HOME = join(process.cwd(), ".test-tmp-home-review-mode");
  const originalHome = process.env.HOME;

  function writeConfig(autoApprove: unknown): void {
    writeFileSync(
      join(TMP_HOME, ".config", "pi-safetynet", "config.json"),
      JSON.stringify({ autoApprove }),
      "utf-8",
    );
  }

  beforeEach(() => {
    process.env.HOME = TMP_HOME;
    delete process.env.SAFETYNET_REVIEW_MODE;
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
    mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.SAFETYNET_REVIEW_MODE;
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  });

  it("defaults to one-shot with no config file at all", async () => {
    const { reviewMode, loadAutoApproveConfig } = await import("./auto-config-state.ts");
    assert.equal(reviewMode(), "one-shot");
    assert.equal(loadAutoApproveConfig().reviewMode, undefined, "absent field means the one-shot default");
    writeConfig({ model: "prov/m" });
    assert.equal(loadAutoApproveConfig().reviewMode, "one-shot", "a config without the field still defaults to one-shot");
  });

  it("reads reviewMode from config and lets the env override it", async () => {
    const { reviewMode } = await import("./auto-config-state.ts");
    writeConfig({ model: "prov/m", reviewMode: "session" });
    assert.equal(reviewMode(), "session", "config reactivates the intense reviewer");
    process.env.SAFETYNET_REVIEW_MODE = "one-shot";
    assert.equal(reviewMode(), "one-shot", "env wins for a quick flip");
    writeConfig({ model: "prov/m", reviewMode: "nonsense" });
    assert.equal(reviewMode(), "one-shot", "unknown values fall back to one-shot");
  });
});
