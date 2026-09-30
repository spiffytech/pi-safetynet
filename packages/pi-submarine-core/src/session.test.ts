import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSubagent } from "./session.ts";

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
