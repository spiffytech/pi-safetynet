/**
 * json-store.ts — shared JSON persistence for safetynet's on-disk stores.
 *
 * Every mutating store here is a read-modify-write of one JSON document, and
 * several documents are shared across concurrent pi sessions (the same
 * approvals.json / inferred-rules.json / config.json). An unguarded RMW loses
 * updates: two sessions read the same document, each adds its own key, and
 * the second rename clobbers the first. That is not hypothetical — it is what
 * erased accepted inferred rules and re-offered them every session.
 *
 * So mutations run inside an exclusive cross-process lock (proper-lockfile,
 * the same lock pi uses for settings/auth/trust) and write via tmp+rename so
 * readers never observe a half-written file. `realpath: false` matches pi's
 * usage and keeps the lock keyed to the exact path we hand it.
 *
 * Fail-safe: `readJsonFile` swallows parse errors and returns null so a
 * corrupt file degrades to "empty" rather than throwing into the permission
 * path. Lock acquisition retries briefly, then throws to the caller — callers
 * in the ask path already wrap their work in try/catch.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { lockSync } from "proper-lockfile";

/** Parse a JSON file, returning null when it is missing or unreadable. */
export function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

/** Atomically replace a JSON file (tmp file + rename). */
export function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
	renameSync(tmp, path);
}

/** Node has no synchronous sleep; Atomics.wait on a shared buffer is the
 *  standard idiom and, unlike a busy-loop, actually yields the CPU. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLockSync(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			lastError = error;
			sleepSync(delayMs);
		}
	}
	throw lastError ?? new Error("safetynet: failed to acquire file lock");
}

/** What a mutation returns: a value for the caller plus (optionally) the
 *  replacement document. Omit `next` to leave the file untouched. */
export interface JsonMutation<T> {
	result: T;
	next?: unknown;
}

/**
 * Read-modify-write a JSON document under an exclusive cross-process lock.
 * `mutate` receives the current parsed document (null when absent/corrupt) and
 * returns the caller's result plus the replacement document. Callers that
 * share a file must spread the incoming document (`{...current, myKey}`) so
 * they preserve sibling keys — that is what makes single-file multi-store
 * persistence safe.
 */
export function withJsonLock<T>(path: string, mutate: (current: unknown) => JsonMutation<T>): T {
	mkdirSync(dirname(path), { recursive: true });
	// proper-lockfile stats the target, so it must exist before locking.
	if (!existsSync(path)) writeFileSync(path, "{}\n");
	const release = acquireLockSync(path);
	try {
		const current = readJsonFile(path);
		const { result, next } = mutate(current);
		if (next !== undefined) writeJsonAtomic(path, next);
		return result;
	} finally {
		release();
	}
}