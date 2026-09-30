import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacySubagentsDisabled } from "./index.ts";

const TMP_HOME = join(process.cwd(), ".test-tmp-home-legacy");
const originalHome = process.env.HOME;

before(() => {
	process.env.HOME = TMP_HOME;
	if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
	mkdirSync(join(TMP_HOME, ".config", "pi-safetynet"), { recursive: true });
});

after(() => {
	process.env.HOME = originalHome;
	if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
});

function writeConfig(content: string | null) {
	const path = join(TMP_HOME, ".config", "pi-safetynet", "config.json");
	if (content === null) {
		if (existsSync(path)) rmSync(path);
		return;
	}
	writeFileSync(path, content);
}

describe("legacy `subagents: []` shutoff (deprecated)", () => {
	it("is off when the config file is absent", () => {
		writeConfig(null);
		assert.equal(legacySubagentsDisabled(), false);
	});

	it("is off when `subagents` is omitted or non-empty", () => {
		writeConfig(JSON.stringify({ rules: [] }));
		assert.equal(legacySubagentsDisabled(), false);
		writeConfig(JSON.stringify({ subagents: ["subagent_run"] }));
		assert.equal(legacySubagentsDisabled(), false);
		writeConfig(JSON.stringify({ subagents: null }));
		assert.equal(legacySubagentsDisabled(), false);
	});

	it("is on when `subagents: []` — suppressing tool registration", () => {
		writeConfig(JSON.stringify({ subagents: [] }));
		assert.equal(legacySubagentsDisabled(), true);
	});

	it("survives a corrupt config file (treated as not-disabled)", () => {
		writeConfig("{ not json");
		assert.equal(legacySubagentsDisabled(), false);
	});
});