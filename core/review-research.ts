/**
 * review-research.ts — model-authored exploration for the permission reviewer.
 *
 * Instead of hand-coding what evidence a reviewer might want (which file lines
 * matter, where the chained logic lives), we hand that judgment back where it
 * belongs: the reviewer writes a small JavaScript research program and we run
 * it in pi's QuickJS sandbox (`@earendil-works/pi-codemode`). The sandbox has
 * no filesystem or network itself — it can only call the four read-only tools
 * bridged below, which apply the same hazardous-file refusal explore children
 * already enforce. No writes, no shell, no secret reads: if the script can't
 * name a safe path, there is no way for it to reach one.
 *
 * The script's text output is what comes back to the reviewer's prompt; what
 * the reviewer deems relevant decides what gets looked at, not us.
 */

import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isHazardousFile } from "./bash-parser.ts";

/** Refuse protected files outright — mirrors the explore-child policy. */
function guardPath(rawPath: string, cwd: string): { ok?: string; err?: string } {
	const trimmed = String(rawPath ?? "").trim();
	if (!trimmed) return { err: "empty path" };
	if (trimmed.includes("\u0000")) return { err: "invalid path" };
	if (isHazardousFile(trimmed)) {
		return {
			err:
				"Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. " +
				"Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.",
		};
	}
	const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	return { ok: abs };
}

function stripUnsafe(text: string): string {
	return text.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\u0000/g, " ");
}

export interface ResearchOpts {
	/** Research program: an async function body using `tools.read/grep/find/ls`. */
	script: string;
	cwd: string;
	/** Per-execution abort; the sandbox also enforces its own timeout. */
	signal?: AbortSignal | undefined;
	/** Wall cap including tool time. Default 60s. */
	timeoutMs?: number;
}

/** Build the four read-only bridges, hazardous-guarded. */
function researchTools(cwd: string): CodemodeTool[] {
	const read: CodemodeTool = {
		name: "read",
		description: "Read a UTF-8 file (up to 200 KB, larger files are truncated).",
		inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		execute: (args) => {
			const { ok, err } = guardPath((args as { path?: string }).path ?? "", cwd);
			if (err || !ok) return { error: err ?? "unresolved path" };
			try {
				const text = readFileSync(ok, "utf-8");
				const clipped = text.length > 200_000 ? text.slice(0, 200_000) + "\n… [truncated]" : text;
				return { content: stripUnsafe(clipped) };
			} catch (e) {
				return { error: String(e) };
			}
		},
	};
	const grep: CodemodeTool = {
		name: "grep",
		description: "Case-sensitive search: returns up to 200 lines matching `pattern` under `path` (file or dir).",
		inputSchema: {
			type: "object",
			properties: { pattern: { type: "string" }, path: { type: "string" } },
			required: ["pattern", "path"],
		},
		execute: (args) => {
			const { pattern = "", path: rawPath = "." } = (args ?? {}) as { pattern?: string; path?: string };
			const guarded = guardPath(rawPath, cwd);
			if (guarded.err || !guarded.ok) return { error: guarded.err ?? "unresolved path" };
			let re: RegExp;
			try {
				re = new RegExp(pattern);
			} catch (e) {
				return { error: `invalid pattern: ${String(e)}` };
			}
			const hits: string[] = [];
			try {
				const st = statSync(guarded.ok);
				const walk = (p: string) => {
					if (hits.length >= 200) return;
					const s = statSync(p, { throwIfNoEntry: false });
					if (!s) return;
					if (s.isDirectory()) {
						for (const entry of readdirSync(p)) walk(join(p, entry));
						return;
					}
					if (!s.isFile() || s.size > 2_000_000) return;
					const rel = relative(cwd, p) || p;
					if (isHazardousFile(rel)) return;
					const lines = readFileSync(p, "utf-8").split("\n");
					for (let i = 0; i < lines.length && hits.length < 200; i++) {
						if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${stripUnsafe(lines[i]!.slice(0, 500))}`);
					}
				};
				walk(guarded.ok);
				void st;
			} catch (e) {
				return { error: String(e) };
			}
			return hits.length > 0 ? { matches: hits } : { matches: [], note: "no matches" };
		},
	};
	const find: CodemodeTool = {
		name: "find",
		description: "List regular files under a directory (recursive, capped at 2000 entries).",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
		execute: (args) => {
			const guarded = guardPath((args as { path?: string } | undefined)?.path ?? ".", cwd);
			if (guarded.err || !guarded.ok) return { error: guarded.err ?? "unresolved path" };
			const out: string[] = [];
			const stack = [guarded.ok];
			try {
				while (stack.length > 0 && out.length < 2000) {
					const cur = stack.pop()!;
					for (const entry of readdirSync(cur, { withFileTypes: true })) {
						const full = join(cur, entry.name);
						if (entry.isDirectory()) {
							stack.push(full);
						} else if (entry.isFile()) {
							const rel = relative(cwd, full) || full;
							if (!isHazardousFile(rel)) out.push(rel);
						}
						if (out.length >= 2000) break;
					}
				}
			} catch (e) {
				return { error: String(e) };
			}
			return { files: out };
		},
	};
	const ls: CodemodeTool = {
		name: "ls",
		description: "List one directory level: names with a trailing slash for subdirectories.",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
		execute: (args) => {
			const guarded = guardPath((args as { path?: string } | undefined)?.path ?? ".", cwd);
			if (guarded.err || !guarded.ok) return { error: guarded.err ?? "unresolved path" };
			try {
				const entries = readdirSync(guarded.ok, { withFileTypes: true }).map((d) =>
					d.isDirectory() ? `${d.name}/` : d.name,
				);
				return { entries: entries.slice(0, 500) };
			} catch (e) {
				return { error: String(e) };
			}
		},
	};
	return [read, grep, find, ls];
}

/**
 * Run a model-authored research script under the QuickJS sandbox. Returns the
 * script's text output as the evidence string ("" when nothing ran), or throws
 * only if the sandbox itself is unusable — callers should treat that as "no
 * evidence" and proceed, never as a review failure.
 */
export async function runResearchScript(opts: ResearchOpts): Promise<string> {
	const sandbox = new CodemodeSandbox({
		tools: researchTools(opts.cwd),
		timeoutMs: opts.timeoutMs ?? 60_000,
	});
	try {
		const result = await sandbox.execute(opts.script, {
			...(opts.signal ? { signal: opts.signal } : {}),
			timeoutMs: opts.timeoutMs ?? 60_000,
		});
		const output = result.output
			.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image omitted]`))
			.join("\n")
			.slice(0, 20_000);
		return output;
	} finally {
		await sandbox.close();
	}
}