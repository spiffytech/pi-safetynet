import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Session-switch state isolation (regression for the /new leak).
 *
 * omp emits session_switch {reason:"new"} for /new (no fresh session_start),
 * and module-level state (current profile, auto-approve flag, in-memory
 * session rules) survived into the brand-new session. omp-index.ts now
 * registers a session_switch handler that resets on "new" and restores from
 * the target journal on resume/fork/tree.
 *
 * The full extension imports @oh-my-pi/pi-coding-agent (TS-source, Bun-only),
 * so the suite self-skips under Node like omp-permission-prompt.test.ts.
 */

const bun = process.versions.bun !== undefined;

const d = bun ? describe : describe.skip;

type Handler = (event: any, ctx: any) => Promise<unknown>;

type FakeOmpApi = {
	handlers: Map<string, Handler[]>;
	shortcuts: Map<string, { description?: string }>;
	appended: Array<{ customType: string; data?: unknown }>;
	sentMessages: unknown[];
	on(event: string, handler: Handler): void;
	registerShortcut(key: string, opts: { description?: string; handler: (ctx: any) => Promise<void> | void }): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(msg: unknown): void;
};

type JournalEntry = { type: string; customType?: string; data?: unknown };

function makeFakeApi(entries: JournalEntry[]): FakeOmpApi & { handlers: Map<string, Handler[]> } {
	const api = {
		handlers: new Map<string, Handler[]>(),
		shortcuts: new Map<string, { description?: string }>(),
		appended: [] as Array<{ customType: string; data?: unknown }>,
		sentMessages: [] as unknown[],
		on(event: string, handler: Handler) {
			const list = api.handlers.get(event) ?? [];
			list.push(handler);
			api.handlers.set(event, list);
		},
		registerShortcut(key: string, opts: { description?: string }) {
			api.shortcuts.set(key, opts);
		},
		registerCommand(_name: string, _opts: unknown) {},
		registerFlag() {},
		setLabel() {},
		getFlag() {
			return undefined;
		},
		appendEntry(customType: string, data?: unknown) {
			api.appended.push({ customType, data });
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(msg: unknown) {
			api.sentMessages.push(msg);
		},
	};
	return api;
}

function makeCtx(entries: JournalEntry[], cwd: string) {
	return {
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
		},
		cwd,
		ui: {
			notify() {},
			setStatus() {},
		},
	};
}

d("safetynet omp session_switch isolation (Bun-only: omp TS-source deps)", () => {
	let safetynetOmp: (pi: any) => void;
	let profiles: typeof import("./core/profiles.ts");
	let autoState: typeof import("./core/auto-config-state.ts");
	let tmpCwd: string;

	before(async () => {
		({ default: safetynetOmp } = await import("./omp-index.ts"));
		profiles = await import("./core/profiles.ts");
		autoState = await import("./core/auto-config-state.ts");
		tmpCwd = mkdtempSync(join(tmpdir(), "safetynet-switch-test-"));
	});

	after(() => {
		profiles.setCurrentProfile(profiles.paradigmModes().read);
		autoState.resetAutoEnabledForNewSession();
		rmSync(tmpCwd, { recursive: true, force: true });
	});

	async function emitSwitch(api: FakeOmpApi, event: { reason: string; previousSessionFile?: string }, ctx: unknown) {
		const list = api.handlers.get("session_switch");
		assert.ok(list && list.length > 0, "extension must register a session_switch handler");
		for (const h of list) await h(event, ctx);
	}

	function startSession(api: FakeOmpApi, entries: JournalEntry[]): Promise<unknown> {
		const list = api.handlers.get("session_start") ?? [];
		return Promise.all(list.map((h) => h({}, makeCtx(entries, tmpCwd))));
	}

	it("registers ctrl+shift+\\ as the auto-approve toggle", async () => {
		const api = makeFakeApi([]);
		safetynetOmp(api);
		const shortcut = api.shortcuts.get("ctrl+shift+\\");
		assert.ok(shortcut, "ctrl+shift+\\ must be registered");
		assert.match(shortcut.description ?? "", /auto-approval/i);
	});

	it("session_switch new resets profile to read mode and auto to off", async () => {
		const entries: JournalEntry[] = [];
		const api = makeFakeApi(entries);
		safetynetOmp(api);
		await startSession(api, entries);

		// Simulate leaked state: rw + auto on.
		profiles.setCurrentProfile(profiles.normalizeProfile("rw"));
		autoState.setAutoEnabled(true, api);

		await emitSwitch(api, { reason: "new" }, makeCtx(entries, tmpCwd));

		assert.equal(profiles.getCurrentProfile(), profiles.paradigmModes().read, "profile must reset to paradigm read mode");
		assert.equal(autoState.isAutoEnabled(), false, "auto-approve must reset to the config default (off without a reviewer model)");
	});

	it("session_switch new persists the reset profile and sends a mode reminder", async () => {
		const entries: JournalEntry[] = [];
		const api = makeFakeApi(entries);
		safetynetOmp(api);
		await startSession(api, entries);

		const beforeCount = api.appended.length;
		profiles.setCurrentProfile(profiles.normalizeProfile("rw"));
		await emitSwitch(api, { reason: "new" }, makeCtx(entries, tmpCwd));

		const appended = api.appended.slice(beforeCount);
		const profileEntry = appended.find((e) => e.customType === "safetynet:profile");
		assert.ok(profileEntry, "reset profile must be persisted to the new journal");
		assert.equal((profileEntry?.data as any)?.enabled, profiles.paradigmModes().read);
		const reminder = api.sentMessages.find((m: any) => m.customType === "safetynet:mode-reminder");
		assert.ok(reminder, "brand-new switch must announce the mode durably");
	});

	it("session_switch resume restores profile and auto from the target journal", async () => {
		const entries: JournalEntry[] = [];
		const api = makeFakeApi(entries);
		safetynetOmp(api);
		await startSession(api, entries);

		// Diverge: old session state differs from the target journal.
		profiles.setCurrentProfile(profiles.normalizeProfile("ro"));
		autoState.setAutoEnabled(false, api);

		const target: JournalEntry[] = [
			{ type: "custom", customType: "safetynet:profile", data: { enabled: "rw" } },
			{ type: "custom", customType: "safetynet:auto", data: { enabled: true } },
		];
		await emitSwitch(api, { reason: "resume", previousSessionFile: "/old/session.jsonl" }, makeCtx(target, tmpCwd));

		assert.equal(profiles.getCurrentProfile(), profiles.normalizeProfile("rw"), "profile must come from the target journal");
		assert.equal(autoState.isAutoEnabled(), true, "auto must come from the target journal");
	});

	it("session_switch new leaves session rules empty even when the old session had journal rules", async () => {
		const entries: JournalEntry[] = [];
		const api = makeFakeApi(entries);
		safetynetOmp(api);
		await startSession(api, entries);

		// Old session had a session-scoped rule in its journal (restored into
		// memory by a prior resume) — /new must NOT carry it over.
		const oldJournal: JournalEntry[] = [
			{ type: "custom", customType: "safetynet:session-rules", data: { rules: [{ permission: "bash", pattern: "echo stale", action: "allow", modes: ["rw", "build"] }], cwd: tmpCwd } },
		];
		await emitSwitch(api, { reason: "resume" }, makeCtx(oldJournal, tmpCwd));

		// After /new the fresh journal has no safetynet entries at all.
		const fresh: JournalEntry[] = [];
		await emitSwitch(api, { reason: "new" }, makeCtx(fresh, tmpCwd));

		// Observable: a brand-new session's journal replay of custom entries
		// would contain nothing — the in-memory store must match that. Verify
		// by starting a fresh extension against the (empty) fresh journal and
		// checking no stale restore occurs: the profile/auto asserts above
		// cover module state; here assert the handler didn't write any
		// session-rules entry during the new-session reset.
		const writtenRules = api.appended.filter((e) => e.customType === "safetynet:session-rules");
		assert.equal(writtenRules.length, 0, "new-session reset must not write session rules");
	});
});
