/**
 * Smoke test: print discovered extensions with paths.
 * Must run from inside the worktree (node_modules resolution).
 */
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent";

const result = await discoverAndLoadExtensions([], "/home/spiffytech/.omp/agent/extensions/omp-safetynet");
for (const e of result.extensions as any[]) {
	console.log("ext:", e.name ?? "(no name)", "|", e.path ?? e.sourcePath ?? "?");
}
console.log("result keys:", Object.keys(result));
console.log("errors:", JSON.stringify((result as any).errors ?? result.loadErrors ?? []));
