import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResearchScript } from "./review-research.ts";

let dir: string;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "review-research-"));
	writeFileSync(join(dir, "notes.md"), "hello from notes\nmarker-token\n");
	writeFileSync(join(dir, ".env"), "SECRET=shh\n");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "app.ts"), "marker-token lives here\n");
});

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("runResearchScript", () => {
	it("runs a model-authored script against the read-only tools", async () => {
		const out = await runResearchScript({
			script: `const r = await tools.read({ path: "notes.md" }); text(r.content);`,
			cwd: dir,
		});
		assert.match(out, /hello from notes/);
	});

	it("refuses to read a hazardous file even from script code", async () => {
		const out = await runResearchScript({
			script: `const r = await tools.read({ path: ".env" }); text(JSON.stringify(r));`,
			cwd: dir,
		});
		assert.match(out, /Sensitive file/);
		assert.doesNotMatch(out, /SECRET/);
	});

	it("grep finds matches across a tree and skips hazardous names", async () => {
		const out = await runResearchScript({
			script: `const r = await tools.grep({ pattern: "marker-token", path: "." }); text(r.matches.join("\\n"));`,
			cwd: dir,
		});
		assert.match(out, /notes\.md/);
		assert.match(out, /src\/app\.ts|src.app\.ts/);
		assert.doesNotMatch(out, /SECRET/);
	});

	it("gives the script no way to write or escape", async () => {
		const out = await runResearchScript({
			script: `text(JSON.stringify({ process: typeof process, fetch: typeof fetch, write: typeof tools.write, require: typeof require }));`,
			cwd: dir,
		});
		assert.match(out, /"process":"undefined"/);
		assert.match(out, /"fetch":"undefined"/);
		assert.match(out, /"write":"undefined"/);
		assert.match(out, /"require":"undefined"/);
	});

	it("reports a script failure without throwing at the host", async () => {
		const out = await runResearchScript({ script: `throw new Error("boom");`, cwd: dir });
		assert.equal(typeof out, "string");
	});
});