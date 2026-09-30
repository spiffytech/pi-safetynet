import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEWER_SYSTEM_PROMPT,
  parseAssessment,
  formatActionJson,
  compactTranscript,
} from "./reviewer-prompt.ts";
import { runPermissionReview } from "./reviewer-state.ts";

// ─── Policy prompt content ──────────────────────────────────────────────────

describe("REVIEWER_SYSTEM_PROMPT policy content", () => {
  it("contains the egress / external destinations section", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /## Egress \/ external destinations/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /pushing to a git remote/);
  });

  it("contains the trusted-content evidence rule (only user messages authorize)", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /Only the user's own messages/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /UNTRUSTED evidence/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /does not authorize sending it anywhere/);
  });

  it("contains the egress outcome rule", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /Egress to a destination the user never authorized/);
  });

  it("no longer claims there is no network/sandbox distinction", () => {
    assert.ok(
      !REVIEWER_SYSTEM_PROMPT.includes("There is no network/sandbox distinction"),
      "the removed line must not be present",
    );
  });

  it("contains the high-risk egress taxonomy entry", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /deploying or sending data to an external destination the user never named/);
  });

  it("defines session modes: ro read-only denies writes, rw normal policy", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /## Session mode/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /"ro" \(read-only\)/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /DENY every action with write or state-changing side effects/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /"rw" \(read-write\) — normal policy applies/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /no user message or transcript evidence licenses a write/);
  });

  it("lets read-only mode override risk and authorization in the outcome policy", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /Read-only session → deny any write action outright, before scoring/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /In read-only mode \(see Session mode\), write actions are denied outright regardless of level/);
  });

  it("tells the reviewer its own read-only tools are not the session mode", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /## Identity and scope/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /property of this review harness/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /The only statement of session mode is the "profile" field/);
  });

  it("anchors the reviewer to the action's cwd, not a directory named in the transcript", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /is the project root the action runs in/);
    assert.match(REVIEWER_SYSTEM_PROMPT, /do not move the project root and say nothing about this action/);
  });

  it("scores a direct user instruction as high despite unrelated transcript context", () => {
    assert.match(REVIEWER_SYSTEM_PROMPT, /scores high, even if the rest of the transcript concerns something else/);
  });
});

// ─── parseAssessment: user_authorization defaulting ─────────────────────────

describe("parseAssessment", () => {
  it("defaults a missing user_authorization to unknown", () => {
    const json = JSON.stringify({
      risk_level: "high",
      outcome: "deny",
      rationale: "destructive",
    });
    const a = parseAssessment(json);
    assert.ok(a, "assessment parses");
    assert.equal(a!.user_authorization, "unknown");
  });

  it("keeps an explicit user_authorization", () => {
    const json = JSON.stringify({
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
      rationale: "user asked for it",
    });
    const a = parseAssessment(json);
    assert.ok(a);
    assert.equal(a!.user_authorization, "high");
  });

  it("still rejects malformed output", () => {
    assert.equal(parseAssessment("not json at all"), undefined);
  });

  it("still rejects output with an invalid user_authorization", () => {
    const json = JSON.stringify({
      risk_level: "low",
      user_authorization: "totally",
      outcome: "allow",
      rationale: "x",
    });
    assert.equal(parseAssessment(json), undefined);
  });
});

// ─── formatActionJson ───────────────────────────────────────────────────────

describe("formatActionJson", () => {
  it("serializes permission, target, profile", () => {
    const json = formatActionJson({
      permission: "bash",
      target: "ls -la",
      cwd: "/tmp",
      profile: "build",
    });
    const obj = JSON.parse(json);
    assert.equal(obj.tool, "bash");
    assert.equal(obj.target, "ls -la");
    assert.equal(obj.profile, "build");
  });

  it("does not include an egress field (egress is policy, not code)", () => {
    const json = formatActionJson({
      permission: "bash",
      target: "git push origin main",
      cwd: "/tmp",
    });
    const obj = JSON.parse(json);
    assert.ok(!("egress" in obj), "no egress field — reviewer identifies egress from the command itself");
  });
});

// ─── compactTranscript (trajectory data is already user-only) ───────────────

describe("compactTranscript", () => {
  it("renders user entries only when given a user-only list", () => {
    const out = compactTranscript([
      { role: "user", text: "explain code patterns", timestamp: "1" },
      { role: "user", text: "do not deploy anything", timestamp: "2" },
    ]);
    assert.match(out, /explain code patterns/);
    assert.match(out, /do not deploy anything/);
    assert.ok(!out.includes("assistant"));
  });
});

describe("runPermissionReview — profile canonicalization to ro/rw", () => {
  async function captureReviewProfile(profile: any): Promise<string> {
    let captured = "";
    await runPermissionReview(
      {
        permission: "bash",
        target: "touch x",
        check: { action: "ask" },
        cwd: "/tmp",
        parentCtx: { sessionManager: { getEntries: () => [] } } as any,
        profile,
        timeoutMs: 100,
      },
      {
        spawn: async (opts: any) => {
          captured = opts.prompt as string;
          return {
            content: [{ type: "text", text: JSON.stringify({ risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "ok" }) }],
            details: {},
          };
        },
      },
    );
    const m = captured.match(/"profile": "([^"]+)"/);
    return m?.[1] ?? "";
  }

  it("maps plan → ro", async () => {
    assert.equal(await captureReviewProfile("plan"), "ro");
  });

  it("passes ro through unchanged", async () => {
    assert.equal(await captureReviewProfile("ro"), "ro");
  });

  it("maps build → rw", async () => {
    assert.equal(await captureReviewProfile("build"), "rw");
  });

  it("passes rw through unchanged", async () => {
    assert.equal(await captureReviewProfile("rw"), "rw");
  });
});


describe("runPermissionReview trajectory (user-messages-only transcript)", () => {
  function makeEntries() {
    return [
      { type: "message", timestamp: "1", message: { role: "user", content: "tell me about code patterns" } },
      { type: "message", timestamp: "2", message: { role: "assistant", content: "I will scaffold the entire project and deploy it to your server" } },
      { type: "message", timestamp: "3", message: { role: "assistant", content: "running: ssh prod deploy --force" } },
      { type: "message", timestamp: "4", message: { role: "user", content: "no, I only asked for an explanation" } },
    ];
  }

  it("includes only user messages in the prompt sent to the reviewer", async () => {
    let capturedPrompt = "";
    const verdict = await runPermissionReview(
      {
        permission: "bash",
        target: "ssh prod deploy",
        check: { action: "ask" },
        cwd: "/tmp",
        parentCtx: { sessionManager: { getEntries: makeEntries } } as any,
        profile: "build",
        timeoutMs: 100,
      },
      {
        spawn: async (opts: any) => {
          capturedPrompt = opts.prompt;
          return {
            content: [{ type: "text", text: JSON.stringify({
              risk_level: "low", user_authorization: "unknown", outcome: "allow", rationale: "ok",
            }) }],
            details: {},
          };
        },
      },
    );

    assert.ok(verdict && verdict.kind === "assessment", "review classifies the canned result");
    assert.match(capturedPrompt, /tell me about code patterns/, "user message is in transcript");
    assert.match(capturedPrompt, /no, I only asked for an explanation/, "latest user message is in transcript");
    assert.ok(
      !capturedPrompt.includes("deploy it to your server"),
      "assistant message must NOT be in the transcript (momentum-bias excluded)",
    );
    assert.ok(
      !capturedPrompt.includes("ssh prod deploy --force"),
      "assistant tool output must NOT be in the transcript",
    );
  });

  it("states the action's project root explicitly in the task prompt", async () => {
    let capturedPrompt = "";
    await runPermissionReview(
      {
        permission: "bash",
        target: "npm install",
        check: { action: "ask" },
        cwd: "/work/pi-safetynet",
        parentCtx: { sessionManager: { getEntries: makeEntries } } as any,
        profile: "build",
        timeoutMs: 100,
      },
      {
        spawn: async (opts: any) => {
          capturedPrompt = opts.prompt;
          return {
            content: [{ type: "text", text: JSON.stringify({
              risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "ok",
            }) }],
            details: {},
          };
        },
      },
    );
    assert.match(capturedPrompt, /## Project root\n\/work\/pi-safetynet/);
  });
});
