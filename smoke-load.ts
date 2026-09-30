/**
 * Smoke test: verify pi discovers and loads BOTH package entrypoints straight
 * from this checkout (the dev path — no `pi install` involved). Run from the
 * repo root:
 *
 *   node --experimental-strip-types smoke-load.ts
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "pi-smoke-load-"));
try {
	mkdirSync(join(agentDir, "extensions"));
	// Stand-in for ~/.pi/agent/extensions/ — the checkout is discovered as one
	// directory whose root manifest declares both entries.
	symlinkSync(process.cwd(), join(agentDir, "extensions", "pi-extras"));

	const result = await discoverAndLoadExtensions([], process.cwd(), agentDir, createEventBus());
	const paths = result.extensions.map((e: { path?: string }) => e.path ?? String(e));
	console.log("discovered entries:", paths);
	if (result.errors.length > 0) console.log("errors:", result.errors);

	const ok =
		result.errors.length === 0 &&
		paths.some((p) => p.includes("packages/pi-safetynet/index.ts")) &&
		paths.some((p) => p.includes("packages/pi-submarine/index.ts"));
	if (!ok) {
		console.error("SMOKE FAILED: expected both package entrypoints to load cleanly");
		process.exitCode = 1;
	} else {
		console.log("SMOKE OK: both entrypoints discovered and loaded from the checkout");
	}
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}