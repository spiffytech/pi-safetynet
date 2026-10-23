/**
 * classifier-review.test.ts — the one-choice classifier contract:
 * allow / narrow / ask / deny, model resolution, auth key handling, failure
 * mapping, nudge/ask propagation, config, and ledger integration.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnClassifierReviewer,
  buildClassifierContext,
  CLASSIFIER_CHOICE_IDS,
} from "./classifier-review.ts";
import { pickReviewSpawn } from "./one-shot-review.ts";
import { classifyReviewResult, runPermissionReview } from "./reviewer-state.ts";
import { setReviewLogEnabled } from "./debug-log.ts";
import {
  DEFAULT_CLASSIFIER_MODEL,
  DEFAULT_CLASSIFIER_THRESHOLD,
  loadAutoApproveConfig,
  reviewMode,
  reviewModelSpecs,
} from "./auto-config-state.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ACTION = {
  tool: "bash",
  target: "cat src/index.ts",
  cwd: "/work/project",
  profile: "rw",
};

function choiceResult(choice: string, p = 0.9, overrides: Record<string, unknown> = {}) {
  return {
    answers: {
      action: {
        type: "choice",
        choice,
        confidence: p,
        probabilities: {
          allow: choice === "allow" ? p : 0.05,
          narrow: choice === "narrow" ? p : 0.05,
          ask: choice === "ask" ? p : 0.05,
          deny: choice === "deny" ? p : 0.05,
        },
      },
    },
    stopReason: "stop",
    model: "jev-1.13.0",
    provider: "typesafe",
    usage: { input_tokens: 300, output_tokens: 0 },
    ...overrides,
  };
}

function registryWith(response: unknown | (() => unknown)) {
  const calls: Array<{ model: unknown; context: any; options: any }> = [];
  return {
    calls,
    registry: {
      getAll: () => [],
      findOfType: (type: string, provider: string, id: string) =>
        type === "classifier"
          ? { id, provider, type: "classifier", api: "typesafe-system-one" }
          : undefined,
      classify: async (model: unknown, context: unknown, options: unknown) => {
        calls.push({ model, context, options });
        return typeof response === "function" ? (response as () => unknown)() : response;
      },
    },
  };
}

function spawnOpts(registry: unknown, overrides: Record<string, unknown> = {}) {
  return {
    taskType: "explore" as const,
    prompt: "legacy markdown prompt",
    parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
    cwd: "/work/project",
    modelSpec: "typesafe/jev-latest",
    timeoutMs: 5_000,
    classifierThreshold: 0.6,
    reviewContext: {
      projectRoot: "/work/project",
      transcript: "[0] user: inspect the auth module",
      assistantIntent: "reading src/index.ts",
      action: ACTION,
    },
    ...overrides,
  } as any;
}

function verdictOf(result: { details: Record<string, unknown> }): any {
  return result.details.verdict;
}

// ─── Request shape ─────────────────────────────────────────────────────────

describe("buildClassifierContext", () => {
  it("sends the command, transcript, and intent as structured state", () => {
    const context = buildClassifierContext(spawnOpts(undefined));
    assert.deepEqual(context.state, {
      projectRoot: "/work/project",
      plannedAction: ACTION,
      transcript: "[0] user: inspect the auth module",
      assistantIntent: "reading src/index.ts",
    });
  });

  it("asks exactly one action question with four choices", () => {
    const { questions } = buildClassifierContext(spawnOpts(undefined));
    const q = questions[CLASSIFIER_CHOICE_IDS.action];
    assert.equal(q.type, "choice");
    assert.deepEqual(Object.keys(q.criteria), ["allow", "narrow", "ask", "deny"]);
    assert.match(q.instructions, /Judge excess, not category/);
    assert.match(q.instructions, /sudo read-only diagnostics/);
    assert.match(q.instructions, /profile is "ro"/);
    assert.match(q.instructions, /task-level go-ahead/i);
  });

  it("carries the session boundaries and the current request", () => {
    const context = buildClassifierContext(
      spawnOpts(undefined, {
        reviewContext: {
          projectRoot: "/work/project",
          transcript: "[0] user: inspect the auth module",
          currentRequest: "run e2e, then deploy rsl-prod",
          trustedRoots: ["/work/project", "/tmp/pi-safetynet/s1"],
          scratchDir: "/tmp/pi-safetynet/s1",
          action: ACTION,
        },
      }),
    );
    assert.equal(context.state.currentRequest, "run e2e, then deploy rsl-prod");
    assert.deepEqual(context.state.trustedRoots, ["/work/project", "/tmp/pi-safetynet/s1"]);
    assert.equal(context.state.scratchDir, "/tmp/pi-safetynet/s1");
  });

  it("falls back to the raw prompt when no structured context is supplied", () => {
    const context = buildClassifierContext(spawnOpts(undefined, { reviewContext: undefined }));
    assert.deepEqual(context.state, { reviewRequest: "legacy markdown prompt" });
  });
});

// ─── One classifier request ────────────────────────────────────────────────

describe("spawnClassifierReviewer", () => {
  it("allows on the allow choice", async () => {
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    const result = await spawnClassifierReviewer(spawnOpts(registry));

    assert.equal(calls.length, 1);
    assert.equal((calls[0]!.model as any).id, "jev-latest");
    assert.deepEqual(verdictOf(result), {
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
      rationale: "Jev allowed this action (P=90.0%).",
      category: "allow",
    });
    assert.equal(result.details.model, "typesafe/jev-1.13.0");
    assert.deepEqual(result.details.classifier, {
      model: "typesafe/jev-1.13.0",
      choice: "allow",
      modelChoice: "allow",
      probability: 0.9,
      probabilities: {
        allow: 0.9,
        narrow: 0.05,
        ask: 0.05,
        deny: 0.05,
      },
      threshold: 0.6,
      ask: false,
      nudge: false,
    });
  });

  it("asks instead of running on a weak allow", async () => {
    const { registry } = registryWith(choiceResult("allow", 0.4));
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.verdict, undefined);
    assert.equal(result.details.ask, true);
    assert.match(String(result.details.askReason), /not confident enough/);
    assert.equal((result.details.classifier as any).ask, true);
  });

  it("turns a weak allow with narrow close behind into a narrow nudge, not a prompt", async () => {
    const { registry } = registryWith({
      answers: {
        action: {
          type: "choice",
          choice: "allow",
          probabilities: { allow: 0.5, narrow: 0.45, ask: 0.05, deny: 0 },
        },
      },
      stopReason: "stop",
      model: "jev-1.13.0",
      provider: "typesafe",
    });
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.ask, undefined);
    assert.equal(verdictOf(result).category, "narrow");
    assert.equal((result.details.classifier as any).modelChoice, "allow");
    assert.equal((result.details.classifier as any).choice, "narrow");
  });

  it("turns a weak allow with ask close behind into a prompt", async () => {
    const { registry } = registryWith({
      answers: {
        action: {
          type: "choice",
          choice: "allow",
          probabilities: { allow: 0.5, narrow: 0.05, ask: 0.45, deny: 0 },
        },
      },
      stopReason: "stop",
      model: "jev-1.13.0",
      provider: "typesafe",
    });
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.ask, true);
    assert.equal(verdictOf(result), undefined);
  });

  it("keeps a weak allow with a decisive margin (the ssh read-only case)", async () => {
    // 0.55 allow / 0.44 ask: the model chose allow and nothing is close to it.
    // Prompting here was the single largest source of unnecessary gates.
    const { registry } = registryWith({
      answers: {
        action: {
          type: "choice",
          choice: "allow",
          probabilities: { allow: 0.55, narrow: 0.01, ask: 0.44, deny: 0 },
        },
      },
      stopReason: "stop",
      model: "jev-1.13.0",
      provider: "typesafe",
    });
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.ask, undefined);
    assert.equal(verdictOf(result).outcome, "allow");
    assert.equal((result.details.classifier as any).choice, "allow");
    assert.equal((result.details.classifier as any).modelChoice, "allow");
    assert.equal((result.details.classifier as any).secondGuessed, undefined);
  });

  it("still asks when the allow is below the floor", async () => {
    const { registry } = registryWith({
      answers: {
        action: {
          type: "choice",
          choice: "allow",
          probabilities: { allow: 0.45, narrow: 0.05, ask: 0.4, deny: 0.1 },
        },
      },
      stopReason: "stop",
      model: "jev-1.13.0",
      provider: "typesafe",
    });
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.ask, true);
    assert.equal((result.details.classifier as any).secondGuessed, true);
  });

  it("nudges the model on narrow", async () => {
    const { registry } = registryWith(choiceResult("narrow", 0.88));
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(verdictOf(result).outcome, "deny");
    assert.equal(verdictOf(result).category, "narrow");
    assert.equal(verdictOf(result).nudge, true);
    assert.match(verdictOf(result).rationale, /too broad/);
    assert.equal((result.details.classifier as any).nudge, true);
  });

  it("asks the user on ask", async () => {
    const { registry } = registryWith(choiceResult("ask", 0.97));
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(result.details.verdict, undefined);
    assert.equal(result.details.ask, true);
    assert.equal(result.details.askReason, "Jev requested your approval");
    assert.equal((result.details.classifier as any).ask, true);
  });

  it("hard-denies on deny", async () => {
    const { registry } = registryWith(choiceResult("deny", 0.99));
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.equal(verdictOf(result).outcome, "deny");
    assert.equal(verdictOf(result).category, "deny");
    assert.equal(verdictOf(result).nudge, undefined);
    assert.match(verdictOf(result).rationale, /catastrophic/);
  });

  it("accepts a classifier model supplied directly", async () => {
    const explicit = { id: "jev-latest", provider: "typesafe", type: "classifier", api: "typesafe-system-one" };
    const { registry, calls } = registryWith(choiceResult("allow"));
    await spawnClassifierReviewer(spawnOpts(registry, { model: explicit, modelSpec: undefined }));
    assert.deepEqual(calls[0]!.model, explicit);
  });

  it("passes JEV_API_KEY for typesafe and not for other providers", async () => {
    const original = process.env.JEV_API_KEY;
    process.env.JEV_API_KEY = "jev-test-key";
    try {
      const { registry, calls } = registryWith(choiceResult("allow"));
      await spawnClassifierReviewer(spawnOpts(registry));
      assert.equal(calls[0]!.options.apiKey, "jev-test-key");
      assert.deepEqual(calls[0]!.options.env, { TYPESAFE_API_KEY: "jev-test-key" });

      const { registry: other, calls: otherCalls } = registryWith(choiceResult("allow"));
      await spawnClassifierReviewer(spawnOpts(other, { modelSpec: "neuralwatt/clef-flash" }));
      assert.equal(otherCalls[0]!.options.apiKey, undefined);
    } finally {
      if (original === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = original;
    }
  });

  it("falls back to getModelsOfType when the registry has no findOfType", async () => {
    const seen: unknown[] = [];
    const registry = {
      getModelsOfType: (type: string) =>
        type === "classifier" ? [{ id: "jev-latest", provider: "typesafe" }] : [],
      classify: async (model: unknown) => {
        seen.push(model);
        return choiceResult("allow");
      },
    };
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.deepEqual(seen[0], { id: "jev-latest", provider: "typesafe" });
    assert.equal(verdictOf(result).outcome, "allow");
  });

  it("reports missing registry, missing classify(), and unknown models", async () => {
    const noRegistry = await spawnClassifierReviewer(spawnOpts(undefined));
    assert.match(String(noRegistry.details.error), /no model registry/);

    const noClassify = await spawnClassifierReviewer(spawnOpts({ getAll: () => [] }));
    assert.match(String(noClassify.details.error), /no classify\(\) entry point/);

    const notFound = await spawnClassifierReviewer(
      spawnOpts({ getAll: () => [], classify: async () => choiceResult("allow") }),
    );
    assert.match(String(notFound.details.error), /not found in the catalog/);
  });

  it("maps provider errors, aborts, and timeouts", async () => {
    const { registry: errored } = registryWith({
      answers: undefined,
      stopReason: "error",
      errorMessage: "429 rate limited",
      usage: { input_tokens: 300 },
    });
    const errorResult = await spawnClassifierReviewer(spawnOpts(errored));
    assert.equal(errorResult.details.error, "429 rate limited");
    assert.deepEqual(errorResult.details.usage, { input_tokens: 300 });

    const { registry: aborted } = registryWith({
      answers: undefined,
      stopReason: "aborted",
    });
    const abortResult = await spawnClassifierReviewer(spawnOpts(aborted));
    assert.equal(abortResult.details.aborted, true);

    const { registry: hanging } = registryWith(() => new Promise(() => {}));
    const timeoutResult = await spawnClassifierReviewer(spawnOpts(hanging, { timeoutMs: 25 }));
    assert.equal(timeoutResult.details.hitTimeout, true);
  });

  it("rejects a response with no usable action choice", async () => {
    const { registry } = registryWith({
      answers: { action: { type: "choice", choice: "maybe", probabilities: {} } },
      stopReason: "stop",
    });
    const result = await spawnClassifierReviewer(spawnOpts(registry));
    assert.match(String(result.details.error), /no usable action choice/);
  });
});

// ─── Verdict propagation ───────────────────────────────────────────────────

describe("classifyReviewResult", () => {
  it("turns ask into a transient prompt", () => {
    const verdict = classifyReviewResult(
      { content: [], details: { ask: true, askReason: "Jev requested your approval" } },
      "typesafe/jev-latest",
    );
    assert.deepEqual(verdict, { kind: "transient", message: "Jev requested your approval" });
  });

  it("propagates category and nudge from the classifier details", () => {
    const verdict = classifyReviewResult(
      {
        content: [],
        details: {
          verdict: {
            risk_level: "medium",
            user_authorization: "unknown",
            outcome: "deny",
            rationale: "This action is too broad.",
          },
          classifier: { choice: "narrow", nudge: true },
        },
      },
      "typesafe/jev-latest",
    );
    assert.equal(verdict.kind, "assessment");
    if (verdict.kind === "assessment") {
      assert.equal(verdict.assessment.category, "narrow");
      assert.equal(verdict.assessment.nudge, true);
    }
  });
});

// ─── runPermissionReview integration ───────────────────────────────────────

describe("runPermissionReview with the classifier spawn", () => {
  afterEach(() => {
    delete process.env.SAFETYNET_REVIEW_MODE;
    setReviewLogEnabled(true);
  });

  it("returns an allow assessment", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    const verdict = await runPermissionReview(
      {
        permission: "bash",
        target: "cat src/index.ts",
        check: { action: "ask" },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    assert.equal(verdict.kind, "assessment");
    if (verdict.kind === "assessment") {
      assert.equal(verdict.assessment.outcome, "allow");
      assert.equal(verdict.assessment.category, "allow");
    }
    assert.equal(calls.length, 1);
  });

  it("returns transient for ask", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry } = registryWith(choiceResult("ask", 0.97));
    const verdict = await runPermissionReview(
      {
        permission: "bash",
        target: "uc deploy -y app",
        check: { action: "ask" },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    assert.equal(verdict.kind, "transient");
    if (verdict.kind === "transient") assert.match(verdict.message, /requested your approval/);
  });

  it("gives the classifier the current request and trusted roots", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    const branch = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "run e2e, then deploy rsl-prod" }],
        },
      },
    ];
    await runPermissionReview(
      {
        permission: "bash",
        target: "uc -c homelab deploy -y rsl-prod",
        check: { action: "ask" },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => branch }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    const state = (calls[0]!.context as any).state;
    assert.equal(state.currentRequest, "run e2e, then deploy rsl-prod");
    assert.ok(Array.isArray(state.trustedRoots));
    assert.ok(state.trustedRoots.includes("/work/project"));
  });

  it("extracts the request after an injected skill block", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    const branch = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "<skill name=\"refract\">long instructions</skill>\n\nAre we ready to deploy?" }],
        },
      },
    ];
    await runPermissionReview(
      {
        permission: "bash",
        target: "uc deploy -y rsl-prod",
        check: { action: "ask" },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => branch }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    const state = (calls[0]!.context as any).state;
    assert.equal(state.currentRequest, "Are we ready to deploy?");
    assert.ok(!state.transcript.includes("long instructions"));
  });

  it("drops an opaque payload from the subcommand list", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    await runPermissionReview(
      {
        permission: "bash",
        target: "ssh -o BatchMode=yes root@host 'free -h; df -h; ls /srv'",
        check: { action: "ask", unapproved: ["ssh -o BatchMode=yes root@host '...'"] },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    const action = (calls[0]!.context as any).state.plannedAction;
    assert.equal(action.subcommands, undefined, "the opaque placeholder is not information");
    assert.match(String(action.target), /free -h/, "the raw command still carries the payload");
  });

  it("keeps concrete subcommands alongside an opaque one", async () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    await runPermissionReview(
      {
        permission: "bash",
        target: "ls /srv && ssh host 'long payload'",
        check: { action: "ask", unapproved: ["ls /srv", "ssh host '...'"] },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    const action = (calls[0]!.context as any).state.plannedAction;
    assert.deepEqual(action.subcommands, ["ls /srv"]);
  });

  it("does not forward the generic external-path reason as suspicion", async () => {
    setReviewLogEnabled(false);
    const { registry, calls } = registryWith(choiceResult("allow", 0.9));
    await runPermissionReview(
      {
        permission: "read",
        target: "/etc/hosts",
        check: { action: "ask", reason: "Path is outside project root" },
        cwd: "/work/project",
        parentCtx: { sessionManager: { getBranch: () => [] }, modelRegistry: registry },
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      { spawn: spawnClassifierReviewer },
    );
    const state = (calls[0]!.context as any).state;
    assert.equal(state.plannedAction.reason, undefined);
  });
});

// ─── Methodology selection ─────────────────────────────────────────────────

describe("pickReviewSpawn classifier mode", () => {
  const sessionSpawn = async () => ({ content: [], details: {} }) as any;

  afterEach(() => {
    delete process.env.SAFETYNET_REVIEW_MODE;
  });

  it("selects the classifier reviewer", () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    assert.equal(pickReviewSpawn(undefined, sessionSpawn), spawnClassifierReviewer);
  });

  it("still lets an injected spawn win", () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    const injected = async () => ({ content: [], details: {} }) as any;
    assert.equal(pickReviewSpawn(injected, sessionSpawn), injected);
  });
});

// ─── Config ────────────────────────────────────────────────────────────────

describe("classifier config", () => {
  const TMP_HOME = join(process.cwd(), ".test-tmp-home-classifier-config");
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

  it("defaults to Jev and a 0.6 allow floor", () => {
    assert.equal(DEFAULT_CLASSIFIER_MODEL, "typesafe/jev-latest");
    assert.equal(DEFAULT_CLASSIFIER_THRESHOLD, 0.6);
    writeConfig({ reviewMode: "classifier" });
    assert.deepEqual(reviewModelSpecs(), ["typesafe/jev-latest"]);
    assert.equal(loadAutoApproveConfig().classifierThreshold, 0.6);
  });

  it("reads classifierModel and clamps the threshold", () => {
    writeConfig({
      reviewMode: "classifier",
      classifierModel: "neuralwatt/clef-flash",
      classifierThreshold: 1.7,
    });
    assert.equal(reviewMode(), "classifier");
    assert.deepEqual(reviewModelSpecs(), ["neuralwatt/clef-flash"]);
    assert.equal(loadAutoApproveConfig().classifierThreshold, 1);

    writeConfig({ reviewMode: "classifier", classifierThreshold: -1 });
    assert.equal(loadAutoApproveConfig().classifierThreshold, 0);
  });

  it("counts classifier mode as having a reviewer model", async () => {
    const { hasReviewerModel } = await import("./auto-config-state.ts");
    writeConfig({ reviewMode: "classifier" });
    assert.equal(hasReviewerModel(), true);
    writeConfig({ reviewMode: "one-shot" });
    assert.equal(hasReviewerModel(), false);
  });

  it("lets SAFETYNET_REVIEW_MODE select classifier mode", () => {
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    assert.equal(reviewMode(), "classifier");
  });
});

// ─── Review ledger ─────────────────────────────────────────────────────────

describe("review ledger classifier records", () => {
  const TMP_HOME = join(process.cwd(), ".test-tmp-home-classifier-ledger");
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = TMP_HOME;
    process.env.SAFETYNET_REVIEW_MODE = "classifier";
    setReviewLogEnabled(true);
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
    mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
  });

  afterEach(() => {
    setReviewLogEnabled(false);
    process.env.HOME = originalHome;
    delete process.env.SAFETYNET_REVIEW_MODE;
    if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
  });

  it("records the classifier choice and category", async () => {
    await runPermissionReview(
      {
        permission: "bash",
        target: "cat src/index.ts",
        check: { action: "ask" },
        cwd: "/tmp",
        parentCtx: { sessionManager: { getBranch: () => [] } } as any,
        profile: "build",
        timeoutMs: 1_000,
        model: "typesafe/jev-latest",
      } as any,
      {
        spawn: (async () => ({
          content: [],
          details: {
            verdict: {
              risk_level: "low",
              user_authorization: "high",
              outcome: "allow",
              rationale: "Jev allowed this action (P=90.0%).",
              category: "allow",
            },
            model: "typesafe/jev-1.13.0",
            classifier: {
              model: "typesafe/jev-1.13.0",
              choice: "allow",
              probability: 0.9,
              threshold: 0.6,
              ask: false,
              nudge: false,
            },
            turnCount: 1,
            activities: [],
            usage: { input: 300, output: 0 },
          },
        })) as any,
      },
    );

    const ledgerPath = join(TMP_HOME, ".cache", "pi-safetynet", "reviews.jsonl");
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    const rec = JSON.parse(lines[lines.length - 1]!);
    assert.equal(rec.mode, "classifier");
    assert.equal(rec.model, "typesafe/jev-1.13.0");
    assert.equal(rec.category, "allow");
    assert.equal(rec.classifier.choice, "allow");
  });
});