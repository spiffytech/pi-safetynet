import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type CreateSubagentSessionResult } from "./session.ts";
import type { VerdictToolDef } from "./child-ext.ts";

/** Minimal AgentSession stub: `runSubagent` drives it and the fake emits one
 *  tool_execution_start event, so the capture seam is exercised without a
 *  real provider/session. */
function fakeSession(toolName: string, args: unknown) {
	let listener: ((event: any) => void) | undefined;
	return {
		agent: {},
		subscribe: (cb: (event: any) => void) => {
			listener = cb;
			return () => {};
		},
		prompt: async () => {
			listener?.({ type: "tool_execution_start", toolName, args, toolCallId: "c1" });
			return true;
		},
		dispose: () => {},
		abort: () => {},
	} as any;
}

const VERDICT_TOOL: VerdictToolDef = {
	name: "submit_verdict",
	label: "Submit verdict",
	description: "verdict",
	promptSnippet: "Submit verdict",
	parameters: {},
	execute: async () => ({ content: [{ type: "text" as const, text: "" }] }),
};

function runWithSession(session: unknown) {
	return runSubagent({
		taskType: "explore",
		prompt: "judge this",
		cwd: "/tmp",
		parentCtx: {} as any,
		verdictTool: VERDICT_TOOL,
		openSession: async (): Promise<CreateSubagentSessionResult> => ({ ok: true, session: session as any }),
	});
}

/**
 * `runSubagent` must refuse to start when handed an already-aborted signal.
 *
 * The reviewer's deadline aborts the shared signal mid-chain; the next model is
 * then spawned with that dead signal. `AbortSignal.addEventListener` never
 * invokes its listener on an already-aborted signal, so without an entry check
 * the session boots and runs to completion despite the cancel.
 */
describe("runSubagent — cancelled signal", () => {
	it("returns an aborted result without creating a session", async () => {
		const ctl = new AbortController();
		ctl.abort();
		const result = await runSubagent({
			taskType: "explore",
			prompt: "irrelevant — must never reach a model",
			signal: ctl.signal,
		} as never);
		assert.equal(result.details.aborted, true);
		assert.equal(result.content[0]?.text, "Subagent aborted.");
	});
});

describe("runSubagent — structured verdict capture", () => {
	it("captures the verdict tool's arguments as details.verdict", async () => {
		const args = { risk_level: "low", user_authorization: "high", outcome: "allow", rationale: "ok" };
		const result = await runWithSession(fakeSession("submit_verdict", args));
		assert.deepEqual(result.details.verdict, args);
	});

	it("leaves details.verdict unset when another tool runs", async () => {
		const result = await runWithSession(fakeSession("read", { path: "x" }));
		assert.equal(result.details.verdict, undefined);
		assert.equal(result.details.noOutput, true, "no verdict ⇒ the no-output path, not a parse claim");
	});
});
