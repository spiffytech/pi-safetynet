/**
 * standalone-services.ts — pi-submarine's own child permission policy, used
 * when pi-safetynet is not installed (no `SafetynetHost` on the event bus).
 *
 * Simple by design: read-only calls pass unless the path is sensitive; bash
 * and file writes are confirmed with the parent session's user; without a UI
 * (headless) everything read-write is refused (fail closed). Shared approvals
 * and ruleset evaluation are pi-safetynet's job — install it for the real
 * engine.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildGateRequest, ChildServices, ChildServicesFactory, ChildVerdict } from "pi-submarine-core";
import { REPORT_TOOL_NAME, WATCH_TOOL_NAME } from "pi-submarine-core";
import { isSensitivePath, normalizeToolPath } from "pi-submarine-core";

const SENSITIVE_REASON =
	"Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.";

const READ_TOOLS = new Set(["read"]);

/** The standalone policy factory. One instance per child session. */
export const standaloneChildServices: ChildServicesFactory = (deps) => {
	async function askUser(ctx: ExtensionContext, what: string): Promise<ChildVerdict> {
		if (!ctx.hasUI) {
			return { block: true, reason: `${what} blocked: interactive approval unavailable (no UI) and pi-safetynet is not installed for rule-based approvals` };
		}
		const ok = await deps.parentCtx.ui.confirm("Submarine subagent request", what);
		if (!ok) {
			deps.onPermissionDenied();
			return { block: true, reason: `User denied: ${what}` };
		}
		return undefined;
	}

	const gate = async (req: ChildGateRequest): Promise<ChildVerdict> => {
		const input = req.input;
		// Child collaboration tools carry no side effects to mediate (report talks
		// to the parent, watch_for registers a read-only wait). Failing closed on
		// them would silently kill child reporting.
		if (req.toolName === REPORT_TOOL_NAME || req.toolName === WATCH_TOOL_NAME) {
			return undefined;
		}
		if (READ_TOOLS.has(req.toolName) || req.toolName === "grep" || req.toolName === "find" || req.toolName === "ls") {
			const rawPath = typeof input.path === "string" ? input.path : undefined;
			if (rawPath && isSensitivePath(normalizeToolPath(rawPath))) {
				return { block: true, reason: SENSITIVE_REASON };
			}
			return undefined;
		}
		if (req.toolName === "bash") {
			return askUser(req.ctx, `Run command: ${String(input.command ?? "")}`);
		}
		if (req.toolName === "edit" || req.toolName === "write") {
			const target = String(input.path ?? input.file_path ?? "?");
			if (isSensitivePath(normalizeToolPath(target))) return { block: true, reason: SENSITIVE_REASON };
			return askUser(req.ctx, `Modify file: ${target}`);
		}
		// Unknown tools are blocked by the registry allowlist upstream; anything
		// that still lands here is refused (fail closed).
		return { block: true, reason: `Tool '${req.toolName}' is not permitted by the standalone subagent policy (install pi-safetynet for rule-based approvals)` };
	};

	return {
		gate,
		isSensitivePath,
	};
};