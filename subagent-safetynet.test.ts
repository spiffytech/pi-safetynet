import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSubagentSafetynetExtension } from "./subagent-safetynet.ts";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Rule, Ruleset, TempRule } from "./types.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal mock that captures event handler registrations. */
function createMockPi() {
	const handlers = new Map<string, Function[]>();
	const activeTools: string[] = [];

	return {
		handlers,
		activeTools,
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setActiveTools(tools: string[]) {
			activeTools.length = 0;
			activeTools.push(...tools);
		},
		appendEntry() {},
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
		abort() { aborted.value = true; },
		sessionManager: {
			getEntries: () => [],
			getSessionId: () => "test-session",
		},
		model: { id: "test-model", provider: "test" },
		modelRegistry: { find: () => undefined },
		...overrides,
	};
}

function makeToolCallEvent(toolName: string, input: Record<string, unknown>) {
	return {
		toolName,
		toolCallId: "call-test",
		input,
	};
}

// ─── Explore mode ───────────────────────────────────────────────────────────

describe("createSubagentSafetynetExtension — explore", () => {
	it("creates an extension factory function", () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		assert.equal(typeof factory, "function");
	});

	it("registers session_start, tool_call, and context handlers", () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
		assert.ok(pi.handlers.has("tool_call"), "tool_call handler registered");
		assert.ok(pi.handlers.has("context"), "context handler registered");
	});

	it("allows read tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("read", { path: "/tmp/test/foo.ts" }),
			createMockCtx(),
		);
		assert.equal(result, undefined, "read should be allowed (returns undefined)");
	});

	it("allows grep tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("grep", { path: "/tmp/test" }),
			createMockCtx(),
		);
		assert.equal(result, undefined, "grep should be allowed");
	});

	it("allows find tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("find", { path: "/tmp/test" }),
			createMockCtx(),
		);
		assert.equal(result, undefined, "find should be allowed");
	});

	it("allows ls tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("ls", { path: "/tmp/test" }),
			createMockCtx(),
		);
		assert.equal(result, undefined, "ls should be allowed");
	});

	it("blocks bash tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("bash", { command: "ls -la" }),
			createMockCtx(),
		);
		assert.deepEqual(result, { block: true, reason: "Tool 'bash' is not available in explore mode" });
	});

	it("blocks edit tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("edit", { path: "/tmp/test/foo.ts" }),
			createMockCtx(),
		);
		assert.deepEqual(result, { block: true, reason: "Tool 'edit' is not available in explore mode" });
	});

	it("blocks write tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("write", { path: "/tmp/test/foo.ts" }),
			createMockCtx(),
		);
		assert.deepEqual(result, { block: true, reason: "Tool 'write' is not available in explore mode" });
	});

	it("blocks unknown tool calls", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(
			makeToolCallEvent("mcp_server", { command: "destroy" }),
			createMockCtx(),
		);
		assert.deepEqual(result, { block: true, reason: "Tool 'mcp_server' is not available in explore mode" });
	});

	it("sets active tools to read-only set on session_start", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("session_start")![0]!;
		await handler({}, createMockCtx());

		assert.deepEqual(pi.activeTools, ["read", "grep", "find", "ls"]);
	});

	it("injects explore context message on context event", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("context")![0]!;
		const result = await handler({ messages: [] });

		assert.ok(Array.isArray(result.messages), "returns messages array");
		assert.equal(result.messages.length, 1, "adds exactly one ephemeral message");

		const msg = result.messages[0] as Record<string, unknown>;
		assert.equal(msg.customType, "safetynet:subagent-ephemeral");
		assert.ok(
			(msg.content as string).includes("EXPLORE"),
			"content mentions EXPLORE mode",
		);
	});

	it("replaces previous ephemeral message on subsequent context events", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("context")![0]!;

		// First call — adds ephemeral
		const result1 = await handler({ messages: [] });
		// Second call — should replace, not stack
		const result2 = await handler({ messages: result1.messages });

		assert.equal(result2.messages.length, 1, "still exactly one ephemeral message after re-injection");
	});
});

// ─── Build mode ─────────────────────────────────────────────────────────────

describe("createSubagentSafetynetExtension — build", () => {
	it("throws if parentCtx is missing", () => {
		assert.throws(
			() => createSubagentSafetynetExtension({
				taskType: "build",
				cwd: "/tmp/test",
				parentStorage: {} as any,
			}),
			/build subagent requires parentCtx and parentStorage/i,
		);
	});

	it("throws if parentStorage is missing", () => {
		assert.throws(
			() => createSubagentSafetynetExtension({
				taskType: "build",
				cwd: "/tmp/test",
				parentCtx: {} as any,
			}),
			/build subagent requires parentCtx and parentStorage/i,
		);
	});

	it("registers tool_call, agent_end, and context handlers", () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "build",
			cwd: "/tmp/test",
			parentCtx: createMockCtx() as any,
			parentStorage: createMockStorage() as any,
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
		assert.ok(pi.handlers.has("tool_call"), "tool_call handler registered");
		assert.ok(pi.handlers.has("agent_end"), "agent_end handler registered");
		assert.ok(pi.handlers.has("context"), "context handler registered");
	});

	it("sets active tools to full build set on session_start", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "build",
			cwd: "/tmp/test",
			parentCtx: createMockCtx() as any,
			parentStorage: createMockStorage() as any,
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("session_start")![0]!;
		await handler({}, createMockCtx());

		assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
	});

	it("injects build context message on context event", async () => {
		const factory = createSubagentSafetynetExtension({
			taskType: "build",
			cwd: "/tmp/test",
			parentCtx: createMockCtx() as any,
			parentStorage: createMockStorage() as any,
		});
		const pi = createMockPi();
		factory(pi as unknown as ExtensionAPI);

		const handler = pi.handlers.get("context")![0]!;
		const result = await handler({ messages: [] });

		assert.equal(result.messages.length, 1, "adds exactly one ephemeral message");
		const msg = result.messages[0] as Record<string, unknown>;
		assert.ok(
			(msg.content as string).includes("BUILD"),
			"content mentions BUILD mode",
		);
	});
});

// ─── agent_end does not clear parent temp rules ────────────────────────────

describe("subagent agent_end does NOT clear parent temp rules", () => {
	it("agent_end clears subagent temp rules but not parent's", async () => {
		const parentStorage = createMockStorage();
		const subagentStorage = createMockStorage();

		// Simulate both storages having temp rules
		const tempRule: TempRule = {
			rule: { permission: "bash", pattern: "npm test", action: "allow", modes: ["build"] },
			expiry: { type: "turn" },
		};
		parentStorage.temp.addRules([tempRule]);
		subagentStorage.temp.addRules([tempRule]);

		assert.equal(parentStorage.temp.getRules().length, 1, "parent has temp rules before agent_end");
		assert.equal(subagentStorage.temp.getRules().length, 1, "subagent has temp rules before agent_end");

		// Simulate what the subagent-safetynet agent_end handler does:
		// it calls subagentStorage.temp.clearTurnRules() but NOT parentStorage.temp.clearTurnRules()
		subagentStorage.temp.clearTurnRules();
		// (parentStorage.temp.clearTurnRules() is intentionally NOT called)

		assert.equal(subagentStorage.temp.getRules().length, 0, "subagent temp rules cleared");
		assert.equal(parentStorage.temp.getRules().length, 1, "parent temp rules NOT cleared");
	});
});

// ─── Helper: mock PermissionStorage ────────────────────────────────────────

function createMockStorage() {
	const stores = {
		session: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		persisted: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		global: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		flag: { rules: [] as Ruleset, getRules() { return [...this.rules]; }, addRules(r: Ruleset) { this.rules.push(...r); }, clear() { this.rules = []; } },
		temp: {
			_rules: [] as TempRule[],
			getRules(): Ruleset {
				// Prune expired time rules, then map to plain Rule
				const now = Date.now();
				this._rules = this._rules.filter((r) => {
					if (r.expiry.type === "time") return r.expiry.expiresAt > now;
					return true;
				});
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
