import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * display.hideToolActivity drives an extra "raw: <target>" header line in the
 * omp permission prompt (omp's transcript hides tool calls entirely when this
 * is set, so the popup is the only place the command is visible).
 *
 * omp-permission-prompt.ts statically imports @oh-my-pi/pi-tui and
 * @oh-my-pi/pi-coding-agent, both TS-source packages that only evaluate under
 * Bun — omp's own runtime. The suite self-skips under Node (pi's test runner);
 * the prompt can never render there, so there is nothing to test.
 */

const bun = process.versions.bun !== undefined;

const d = bun ? describe : describe.skip;

d("isToolActivityHidden (Bun-only: omp TS-source deps)", () => {
	let isToolActivityHidden: () => boolean;

	before(async () => {
		({ isToolActivityHidden } = await import("./omp-permission-prompt.ts"));
		const { Settings } = await import("@oh-my-pi/pi-coding-agent");
		// In-memory singleton: never touches the user's real config or agent.db.
		await Settings.init({ inMemory: true });
	});

	after(async () => {
		const { Settings } = await import("@oh-my-pi/pi-coding-agent");
		Settings.instance.clearOverride("display.hideToolActivity");
	});

	it("defaults to false when the setting is unset", () => {
		assert.equal(isToolActivityHidden(), false);
	});

	it("reads true live when hideToolActivity is set at runtime", async () => {
		const { Settings } = await import("@oh-my-pi/pi-coding-agent");
		Settings.instance.override("display.hideToolActivity", true);
		assert.equal(isToolActivityHidden(), true);
	});

	it("reflects toggling back off immediately (no restart)", async () => {
		const { Settings } = await import("@oh-my-pi/pi-coding-agent");
		Settings.instance.override("display.hideToolActivity", true);
		Settings.instance.clearOverride("display.hideToolActivity");
		assert.equal(isToolActivityHidden(), false);
	});
});
