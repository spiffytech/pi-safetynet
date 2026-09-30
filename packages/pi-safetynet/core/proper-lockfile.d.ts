/**
 * proper-lockfile ships no bundled types and no @types package is installed
 * (npm install currently fails on an unrelated transitive version conflict in
 * this repo). Declare only the synchronous lock surface core/json-store.ts
 * uses; proper-lockfile is already a hoisted dependency of pi itself, so the
 * runtime module resolves without adding a lockfile entry.
 */
declare module "proper-lockfile" {
	export interface LockOptions {
		stale?: number;
		update?: number;
		retries?: number | Record<string, unknown>;
		realpath?: boolean;
		onCompromised?: (error: Error) => void;
	}

	export type Release = () => void;

	export function lock(file: string, options?: LockOptions): Promise<Release>;
	export function lockSync(file: string, options?: LockOptions): Release;
	export function unlock(file: string, options?: LockOptions): Promise<void>;
	export function unlockSync(file: string, options?: LockOptions): void;
	export function check(file: string, options?: LockOptions): Promise<boolean>;
	export function checkSync(file: string, options?: LockOptions): boolean;
}