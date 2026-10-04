/**
 * child-ext.test.ts — the subagent child extension delegates every permission
 * decision to injected ChildServices and enforces the explore allowlist itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildExtension, activeToolNames, type ChildServicesFactory, type ChildGateRequest, type ChildVerdict, type VerdictToolDef } from "./index.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal mock that captures event handler registrations. */
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

/** Fake services: records gate/turn-end calls, returns a scripted verdict. */
function fakeServices(verdict: ChildVerdict = undefined) {
	const received: ChildGateRequest[] = [];
	let turnEnds = 0;
	let toolHooks = 0;
	const factory: ChildServicesFactory = () => ({
		gate: async (req) => {
			received.push(req);
			return verdict;
		},
		registerChildTools: () => {
			toolHooks++;
		},
		onTurnEnd: () => {
			turnEnds++;
		},
	});
	return {
		factory,
		received,
		turnEnds: () => turnEnds,
		toolHooks: () => toolHooks,
	};
}

function buildChild(opts: {
	taskType: "explore" | "build";
	omitContextMessage?: boolean;
	services?: ChildServicesFactory;
	verdict?: VerdictToolDef;
} = { taskType: "explore" }) {
	const factory = createChildExtension({
		taskType: opts.taskType,
		cwd: "/tmp/test",
		parentCtx: createMockCtx() as any,
		onPermissionDenied: () => {},
		services: opts.services ?? fakeServices().factory,
		serviceInputs: { trustExternalPaths: false, paradigm: "plan-build", modeAliases: {} },
		...(opts.omitContextMessage !== undefined ? { omitContextMessage: opts.omitContextMessage } : {}),
		...(opts.verdict !== undefined ? { verdict: opts.verdict } : {}),
	});
	const pi = createMockPi();
	factory(pi as unknown as ExtensionAPI);
	return pi;
}

// ─── Explore mode ───────────────────────────────────────────────────────────

describe("child extension — explore", () => {
	it("creates an extension factory function", () => {
		const factory = createChildExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			parentCtx: createMockCtx() as any,
			onPermissionDenied: () => {},
			services: fakeServices().factory,
			serviceInputs: { trustExternalPaths: false, paradigm: "plan-build", modeAliases: {} },
		});
		assert.equal(typeof factory, "function");
	});

	it("registers session_start, tool_call, and context handlers", () => {
		const pi = buildChild({ taskType: "explore" });
		assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
		assert.ok(pi.handlers.has("tool_call"), "tool_call handler registered");
		assert.ok(pi.handlers.has("context"), "context handler registered");
	});

	it("injects the generic explore identity by default", async () => {
		const pi = buildChild({ taskType: "explore" });
		const handler = pi.handlers.get("context")![0]!;
		const result = await handler({ messages: [] }, createMockCtx());
		const injected = result.messages.find((m: any) => typeof m.content === "string");
		assert.ok(injected, "generic context message injected");
		assert.match(injected.content, /read-only explore subagent/);
	});

	it("omits the generic explore identity for specialized subagents (reviewer/judge)", async () => {
		const pi = buildChild({ taskType: "explore", omitContextMessage: true });
		assert.equal(pi.handlers.has("context"), false, "no context handler installed");
	});

	for (const tool of ["read", "grep", "find", "ls"]) {
		it(`allows ${tool} tool calls`, async () => {
			const pi = buildChild({ taskType: "explore" });
			const handler = pi.handlers.get("tool_call")![0]!;
			const result = await handler(makeToolCallEvent(tool, { path: "src/app.ts" }), createMockCtx());
			assert.equal(result, undefined, `${tool} should be allowed (returns undefined)`);
		});
	}

	for (const tool of ["bash", "edit", "write", "mcp_server"]) {
		it(`blocks ${tool} tool calls`, async () => {
			const pi = buildChild({ taskType: "explore" });
			const handler = pi.handlers.get("tool_call")![0]!;
			const result = await handler(makeToolCallEvent(tool, { path: "x", command: "ls" }), createMockCtx());
			assert.deepEqual(result, { block: true, reason: `Tool '${tool}' is not available in explore mode` });
		});
	}

	it("sets active tools to read-only set on session_start", async () => {
		const pi = buildChild({ taskType: "explore" });
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		assert.deepEqual(pi.activeTools, ["read", "grep", "find", "ls", "codemode_research"]);
	});

	it("injects explore context message on context event", async () => {
		const pi = buildChild({ taskType: "explore" });
		const handler = pi.handlers.get("context")![0]!;
		const result = await handler({ messages: [] }, createMockCtx());
		assert.equal(result.messages.length, 1, "adds exactly one ephemeral message");
		const msg = result.messages[0] as Record<string, unknown>;
		assert.ok((msg.content as string).includes("EXPLORE"), "content mentions EXPLORE mode");
	});

	it("replaces previous ephemeral message on subsequent context events", async () => {
		const pi = buildChild({ taskType: "explore" });
		const handler = pi.handlers.get("context")![0]!;
		const first = await handler({ messages: [] }, createMockCtx());
		const second = await handler({ messages: first.messages }, createMockCtx());
		assert.equal(second.messages.length, 1, "no duplicate ephemeral messages");
	});

	it("calls the host's child-tool hook (e.g. the research tool)", () => {
		const fake = fakeServices();
		const pi = buildChild({ taskType: "explore", services: fake.factory });
		assert.equal(fake.toolHooks(), 1, "registerChildTools called once");
		assert.ok(pi.handlers.has("session_start"));
	});
});

// ─── Explore sensitive-read guard ─────────────────────────────────────────

describe("explore subagent hazardous-read guard", () => {
	async function callExplore(toolName: string, input: Record<string, unknown>) {
		const pi = buildChild({ taskType: "explore" });
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		const toolHandler = pi.handlers.get("tool_call")![0]!;
		return toolHandler(makeToolCallEvent(toolName, input), createMockCtx());
	}

	it("blocks reading a hazardous file the parent itself would deny", async () => {
		for (const p of [".env", "@.env", ".ssh/id_rsa", ".npmrc", ".ENV"]) {
			const result = await callExplore("read", { path: p });
			assert.ok(result, `${p} must be blocked`);
			assert.equal(result!.block, true);
			assert.match(result!.reason, /Sensitive file/);
		}
	});

	it("still allows a normal read", async () => {
		assert.equal(await callExplore("read", { path: "src/app.ts" }), undefined);
	});
});

// ─── Build mode: delegation, fail-closed, turn resets ──────────────────────

describe("child extension — build", () => {
	it("registers tool_call, agent_end, and context handlers", () => {
		const pi = buildChild({ taskType: "build" });
		assert.ok(pi.handlers.has("session_start"), "session_start handler registered");
		assert.ok(pi.handlers.has("tool_call"), "tool_call handler registered");
		assert.ok(pi.handlers.has("agent_end"), "agent_end handler registered");
		assert.ok(pi.handlers.has("context"), "context handler registered");
	});

	it("sets active tools to the full build set on session_start", async () => {
		const pi = buildChild({ taskType: "build" });
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode_research"]);
	});

	it("injects build context message on context event", async () => {
		const pi = buildChild({ taskType: "build" });
		const handler = pi.handlers.get("context")![0]!;
		const result = await handler({ messages: [] }, createMockCtx());
		assert.equal(result.messages.length, 1, "adds exactly one ephemeral message");
		const msg = result.messages[0] as Record<string, unknown>;
		assert.ok((msg.content as string).includes("BUILD"), "content mentions BUILD mode");
	});

	it("delegates each tool call to the gate", async () => {
		const fake = fakeServices({ block: true, reason: "nope" });
		const pi = buildChild({ taskType: "build", services: fake.factory });
		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(makeToolCallEvent("bash", { command: "echo hi" }), createMockCtx());
		assert.equal(fake.received.length, 1, "gate consulted once");
		assert.equal(fake.received[0]?.toolName, "bash");
		assert.deepEqual(result, { block: true, reason: "nope" }, "gate verdict passes through");
	});

	it("allows the call when the gate allows it", async () => {
		const fake = fakeServices(undefined);
		const pi = buildChild({ taskType: "build", services: fake.factory });
		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(makeToolCallEvent("bash", { command: "echo hi" }), createMockCtx());
		assert.equal(result, undefined);
	});

	it("fails closed when the gate throws", async () => {
		const pi = buildChild({
			taskType: "build",
			services: () => ({
				gate: async () => {
					throw new Error("boom");
				},
			}),
		});
		const handler = pi.handlers.get("tool_call")![0]!;
		const ctx = createMockCtx();
		const result = await handler(makeToolCallEvent("bash", { command: "echo hi" }), ctx as any);
		assert.ok(result?.block, "a broken gate must block, not allow");
		assert.match(result!.reason, /blocked to be safe/);
	});

	it("signals the gate on agent_end (turn-scoped state reset)", async () => {
		const fake = fakeServices();
		const pi = buildChild({ taskType: "build", services: fake.factory });
		await pi.handlers.get("agent_end")![0]!();
		assert.equal(fake.turnEnds(), 1, "onTurnEnd called once");
	});
});

// ─── Nested tool-call parity (pi ctx.executeTool) ──────────────────────────
//
// Nested calls arrive at the same `tool_call` handler carrying
// `parentToolCallId`. Every gate must treat them exactly like a direct model
// call — special-casing nested calls would reopen a whole bypass class.

describe("nested tool-call parity — parentToolCallId calls gate identically", () => {
	it("build: a nested bash call is delegated exactly like a direct one", async () => {
		const fake = fakeServices({ block: true, reason: "Sensitive file" });
		const pi = buildChild({ taskType: "build", services: fake.factory });
		const handler = pi.handlers.get("tool_call")![0]!;
		const direct = await handler(makeToolCallEvent("bash", { command: "cat .env" }), createMockCtx());
		const nested = await handler(
			{ ...makeToolCallEvent("bash", { command: "cat .env" }), parentToolCallId: "parent-1" },
			createMockCtx(),
		);
		assert.deepEqual(nested, direct, "nested and direct calls resolve identically");
		assert.equal(nested?.block, true);
	});

	it("explore: an out-of-allowlist tool is rejected identically whether nested or direct", async () => {
		const pi = buildChild({ taskType: "explore" });
		const handler = pi.handlers.get("tool_call")![0]!;
		const direct = await handler(makeToolCallEvent("bash", { command: "ls" }), createMockCtx());
		const nested = await handler(
			{ ...makeToolCallEvent("bash", { command: "ls" }), parentToolCallId: "parent-1" },
			createMockCtx(),
		);
		assert.deepEqual(nested, direct, "nested and direct calls resolve identically");
		assert.ok(nested?.block, "explore rejects bash whether or not the call is nested");
	});
});

describe("activeToolNames", () => {
	it("matches the regression lists", () => {
		assert.deepEqual(activeToolNames("explore", false), ["read", "grep", "find", "ls", "codemode_research"]);
		assert.deepEqual(activeToolNames("explore", true).at(-1), "report_to_parent");
		assert.deepEqual(activeToolNames("build", false), ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode_research"]);
	});

	it("appends extra tool names", () => {
		assert.deepEqual(
			activeToolNames("explore", false, false, ["submit_verdict"]),
			["read", "grep", "find", "ls", "codemode_research", "submit_verdict"],
		);
	});
});

// ─── Structured verdict tool ───────────────────────────────────────────────

describe("child extension — structured verdict", () => {
	const tool: VerdictToolDef = {
		name: "submit_verdict",
		label: "Submit verdict",
		description: "verdict",
		parameters: { type: "object" },
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};

	it("registers the verdict tool and activates it on session_start", async () => {
		const pi = buildChild({ taskType: "explore", verdict: tool });
		assert.ok(pi.registeredTools.some((t) => t.name === "submit_verdict"), "verdict tool registered");
		await pi.handlers.get("session_start")![0]!({}, createMockCtx());
		assert.ok(pi.activeTools.includes("submit_verdict"), "verdict tool active");
	});

	it("allowlists the verdict tool in explore mode", async () => {
		const pi = buildChild({ taskType: "explore", verdict: tool });
		const handler = pi.handlers.get("tool_call")![0]!;
		const result = await handler(makeToolCallEvent("submit_verdict", { risk_level: "low" }), createMockCtx());
		assert.equal(result, undefined, "verdict tool allowed");
	});

	it("nudges once at settle when the verdict tool was not called", async () => {
		const pi = buildChild({ taskType: "explore", verdict: tool });
		const settle = pi.handlers.get("agent_before_settle")![0]!;
		const first = await settle({}, createMockCtx());
		assert.equal(first?.continue, true);
		assert.equal(first!.entries[0].customType, "safetynet:verdict-reminder");
		const second = await settle({}, createMockCtx());
		assert.equal(second, undefined, "nudges once, then stays silent");
	});

	it("does not nudge after the verdict tool is called", async () => {
		const pi = buildChild({ taskType: "explore", verdict: tool });
		await pi.handlers.get("tool_execution_start")![0]!({ toolName: "submit_verdict" }, createMockCtx());
		const result = await pi.handlers.get("agent_before_settle")![0]!({}, createMockCtx());
		assert.equal(result, undefined);
	});
});