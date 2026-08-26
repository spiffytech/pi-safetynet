/**
 * Smoke test: verify omp discovers and loads the safetynet extension.
 * Run from inside the worktree: bun run-smoke.ts
 */
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent";

const result = await discoverAndLoadExtensions([], import.meta.dir);
const paths = result.extensions.map((e: any) => e.path ?? e.sourcePath ?? "");
console.log("loaded:", JSON.stringify(paths, null, 2));
console.log("errors:", JSON.stringify(result.errors ?? []));

const mine = paths.find((p) => p.includes("omp-safetynet/omp-index.ts"));
if (!mine) {
	console.error("FAIL: safetynet extension not discovered");
	process.exit(1);
}
console.log("OK: safetynet loaded");
