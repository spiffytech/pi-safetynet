import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSubagentSafetynetExtension, REPORT_TOOL_NAME } from "./subagent-safetynet.ts";
import { subagentToolNames } from "./subagent.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Minimal extension API mock: captures tools and event handlers. */
function createMockPi() {
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const activeTools: string[] = [];
	return {
		handlers,
		tools,
		activeTools,
		on(event: string, handler: Function) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		setActiveTools(names: string[]) {
			activeTools.length = 0;
			activeTools.push(...names);
		},
		appendEntry() {},
		sendMessage() {},
	};
}

function createMockCtx(): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/tmp/test",
		ui: { notify() {}, select: async () => undefined, confirm: async () => false, custom: async () => null, setStatus() {}, setWidget() {} },
		abort() {},
		signal: undefined,
		isIdle: () => true,
		isProjectTrusted: () => false,
		hasPendingMessages: () => false,
		sessionManager: { getEntries: () => [], getSessionId: () => "s", getBranch: () => [] },
		model: { id: "m", provider: "p" },
		modelRegistry: { find: () => undefined },
	} as unknown as ExtensionContext;
}

async function runHandlers(mock: ReturnType<typeof createMockPi>, event: string) {
	for (const h of mock.handlers.get(event) ?? []) await h();
}

describe("subagent tool allowlist", () => {
	it("includes report_to_parent only for collaborative children", () => {
		assert.ok(subagentToolNames("explore", true).includes(REPORT_TOOL_NAME));
		assert.ok(subagentToolNames("build", true).includes(REPORT_TOOL_NAME));
		assert.equal(subagentToolNames("explore", false).includes(REPORT_TOOL_NAME), false);
		assert.equal(subagentToolNames("build", false).includes(REPORT_TOOL_NAME), false);
	});
});

describe("report_to_parent registration", () => {
	it("is registered and usable for collaborative explore subagents", async () => {
		const mock = createMockPi();
		const segment = { reported: false, nudged: false };
		const sent: Array<{ summary: string; body?: string; urgent?: boolean }> = [];
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			reporting: { send: (r) => sent.push(r), segment },
		});
		factory(mock as unknown as ExtensionAPI);
		await runHandlers(mock, "session_start");

		assert.ok(mock.activeTools.includes(REPORT_TOOL_NAME), "report tool is active");
		const tool = mock.tools.get(REPORT_TOOL_NAME);
		assert.ok(tool, "report tool registered");
		await tool.execute("call", { summary: "found it", body: "detail", urgent: true }, undefined, undefined, createMockCtx());
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], { summary: "found it", body: "detail", urgent: true });
		assert.equal(segment.reported, true);
	});

	it("is NOT registered for internal (non-collaborative) subagents", () => {
		const mock = createMockPi();
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			omitContextMessage: true,
		});
		factory(mock as unknown as ExtensionAPI);
		assert.equal(mock.tools.has(REPORT_TOOL_NAME), false);
		assert.equal(mock.handlers.has("agent_before_settle"), false);
	});
});

describe("one-shot settle guard", () => {
	it("nudges exactly once, then lets the child settle", async () => {
		const mock = createMockPi();
		const segment = { reported: false, nudged: false };
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			reporting: { send: () => {}, segment },
		});
		factory(mock as unknown as ExtensionAPI);

		const guard = (mock.handlers.get("agent_before_settle") ?? [])[0] as Function;
		const first = await guard();
		assert.equal(first.continue, true);
		assert.ok(Array.isArray(first.entries) && first.entries.length === 1);
		assert.equal(first.entries[0].type, "custom_message");

		const second = await guard();
		assert.equal(second, undefined, "no second nudge");
	});

	it("does not nudge after the child reports", async () => {
		const mock = createMockPi();
		const segment = { reported: true, nudged: false };
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			reporting: { send: () => {}, segment },
		});
		factory(mock as unknown as ExtensionAPI);
		const guard = (mock.handlers.get("agent_before_settle") ?? [])[0] as Function;
		assert.equal(await guard(), undefined);
	});

	it("never re-nudges after a report, even when segment state resets", async () => {
		// `subagent_send` always resets segment state (a steer is new work), so a
		// child that already reported could otherwise be nudged again — and again
		// — until its appendages loop away. A live child burned thousands of
		// tokens on repeated empty continuations exactly this way.
		const mock = createMockPi();
		const segment = { reported: false, nudged: false };
		const factory = createSubagentSafetynetExtension({
			taskType: "explore",
			cwd: "/tmp/test",
			reporting: { send: () => {}, segment },
		});
		factory(mock as unknown as ExtensionAPI);

		const tool = mock.tools.get(REPORT_TOOL_NAME);
		assert.ok(tool);
		await tool.execute("call", { summary: "done" }, undefined, undefined, createMockCtx());

		// Simulate the reset beginSegment() applies mid-run.
		segment.reported = false;
		segment.nudged = false;

		const guard = (mock.handlers.get("agent_before_settle") ?? [])[0] as Function;
		assert.equal(await guard(), undefined, "a session that already reported is never nudged again");
	});
});
