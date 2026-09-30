/**
 * child-services.test.ts — pi-safetynet's permission gate for build subagents:
 * shared permission pool with the parent, fail-closed hazardous handling, and
 * identical treatment of nested (ctx.executeTool) calls.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildExtension } from "pi-submarine-core";
import type { Rule, Ruleset, TempRule } from "./core/types.ts";
import { createSafetynetChildServices } from "./src/child-services.ts";

// ─── HOME isolation: the gate reads keybindings/auto-deny from global config ─

const TMP_HOME = join(process.cwd(), ".test-tmp-home-gate");
const originalHome = process.env.HOME;

before(() => {
	process.env.HOME = TMP_HOME;
	if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
	mkdirSync(TMP_HOME, { recursive: true });
});

after(() => {
	process.env.HOME = originalHome;
	if (existsSync(TMP_HOME)) rmSync(TMP_HOME, { recursive: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockPi() {
	const handlers = new Map<string, Function[]>();
	const activeTools: string[] = [];
	const registeredTools: Array<{ name: string }> = [];
	return {
		handlers,
		activeTools,
		registeredTools,
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string }) {
			registeredTools.push({ name: tool.name });
		},
		setActiveTools(tools: string[]) {
			activeTools.length = 0;
			activeTools.push(...tools);
		},
		appendEntry() {},
		sendMessage() {},
	};
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
	const aborted = { value: false };
	return {
		aborted,
		hasUI: true,
		cwd: "/tmp/test",
		ui: {
			notify: () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => null,
			setStatus: () => {},
			setWidget: () => {},
		},
		abort() {
			aborted.value = true;
		},
		sessionManager: { getEntries: () => [], getSessionId: () => "test-session" },
		model: { id: "test-model", provider: "test" },
		modelRegistry: { find: () => undefined },
		...overrides,
	};
}

function makeToolCallEvent(toolName: string, input: Record<string, unknown>) {
	return { toolName, toolCallId: "call-test", input };
}

/** Implements just enough of PermissionStorage for the gate and pipeline. */
function createMockStorage() {
	const stores = {
		session: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		persisted: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		global: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		flag: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		temp: {
			_rules: [] as TempRule[],
			getRules(): Ruleset {
				return this._rules.map((r) => r.rule);
			},
			addRules(r: TempRule[]) { this._rules.push(...r); },
			clearTurnRules() { this._rules = this._rules.filter((r) => r.expiry.type !== "turn"); },
			clear() { this._rules = []; },
		},
	};

	return {
		...stores,
		getAllRules(): Ruleset {
			return [
				...stores.session.getRules(),
				...stores.persisted.getRules(),
				...stores.global.getRules(),
				...stores.flag.getRules(),
				...stores.temp.getRules(),
			];
		},
		addSessionRules(r: Ruleset) { stores.session.addRules(r); },
		addFlagRules(r: Ruleset) { stores.flag.addRules(r); },
		addTempRules(r: TempRule[]) { stores.temp.addRules(r); },
		async addPersistedRules(r: Ruleset) { stores.persisted.addRules(r); },
		async addGlobalRules(r: Ruleset) { stores.global.addRules(r); },
		async init() {},
	};
}

/** Build a child extension backed by the real safetynet gate. */
function buildChild(
	taskType: "explore" | "build",
	parentStorage: ReturnType<typeof createMockStorage>,
	onPermissionDenied: () => void = () => {},
) {
	const factory = createChildExtension({
		taskType,
		cwd: "/tmp/test",
		parentCtx: createMockCtx() as any,
		onPermissionDenied,
		services: createSafetynetChildServices(parentStorage as any),
		serviceInputs: { trustExternalPaths: false, paradigm: "plan-build", modeAliases: {} },
	});
	const pi = createMockPi();
	factory(pi as unknown as ExtensionAPI);
	return pi;
}

// ─── Gates ─────────────────────────────────────────────────────────────────

describe("safetynet child gate — build", () => {
	it("hazardous bash deny in subagent: nudge-and-continue, no abort on 1st strike", async () => {
		let denied = 0;
		const pi = buildChild("build", createMockStorage(), () => {
			denied++;
		});
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());

		const toolHandler = pi.handlers.get("tool_call")![0]!;
		const ctx = createMockCtx();
		const result = await toolHandler(makeToolCallEvent("bash", { command: "echo x > .env" }), ctx as any);

		assert.ok(result, "bash redirect to hazardous file is denied");
		assert.equal(result!.block, true);
		assert.equal(ctx.aborted.value, false, "1st hazardous deny must NOT abort the subagent");
		assert.equal(denied, 0, "the deny callback is for hard rejections only");
		assert.match(result!.reason, /Sensitive file/, "reason names the sensitive file");
	});
});

describe("build subagent shares the parent's permission pool", () => {
	async function buildWithParent() {
		const parentStorage = createMockStorage();
		const pi = buildChild("build", parentStorage);
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		return { pi, parentStorage };
	}

	it("honors a rule already granted in the parent (no re-prompt)", async () => {
		const { pi, parentStorage } = await buildWithParent();
		parentStorage.temp.addRules([
			{ rule: { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] }, expiry: { type: "turn" } },
		]);
		const result = await pi.handlers.get("tool_call")![0]!(
			makeToolCallEvent("bash", { command: "npm test" }),
			createMockCtx(),
		);
		assert.equal(result, undefined, "a parent-granted rule authorizes the child");
	});

	it("a child's agent_end leaves the shared pool's turn rules intact", async () => {
		const { pi, parentStorage } = await buildWithParent();
		parentStorage.temp.addRules([
			{ rule: { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] }, expiry: { type: "turn" } },
		]);
		await pi.handlers.get("agent_end")![0]!();
		assert.equal(parentStorage.temp.getRules().length, 1, "a child must not clear the shared pool mid-turn");
	});
});

describe("nested tool-call parity — parentToolCallId calls gate identically", () => {
	it("build: a nested bash call is denied exactly like a direct one", async () => {
		const pi = buildChild("build", createMockStorage());
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		const handler = pi.handlers.get("tool_call")![0]!;
		const direct = await handler(makeToolCallEvent("bash", { command: "cat .env" }), createMockCtx());
		const nested = await handler(
			{ ...makeToolCallEvent("bash", { command: "cat .env" }), parentToolCallId: "parent-1" },
			createMockCtx(),
		);
		assert.equal(nested?.block, true, "a nested call is still gated");
		assert.match(nested?.reason ?? "", /Sensitive file/);
		assert.equal(
			JSON.stringify([nested?.block, nested?.reason]),
			JSON.stringify([direct?.block, direct?.reason]),
			"nested and direct calls resolve identically",
		);
	});
});

describe("host child tools", () => {
	it("registerChildTools installs the reviewer's research tool", () => {
		const storage = createMockStorage();
		const services = createSafetynetChildServices(storage as any)({
			taskType: "explore",
			cwd: "/tmp/test",
			parentCtx: createMockCtx() as any,
			trustExternalPaths: false,
			paradigm: "plan-build",
			modeAliases: {},
			onPermissionDenied: () => {},
			sendToChild: () => {},
		});
		const pi = createMockPi();
		services.registerChildTools?.(pi as unknown as ExtensionAPI);
		assert.deepEqual(pi.registeredTools.map((t) => t.name), ["codemode_research"]);
	});
});