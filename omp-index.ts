/**
 * omp port of pi-safetynet — Phase 2 skeleton.
 *
 * Wires omp's `tool_call` interception to the shared core/ permission
 * checkers (same logic as the pi frontend). Phase 2 scope: allow passes
 * silently, ask/deny blocks with a reason. Interactive askDialog prompts,
 * profile/paradigm state machine, reviewer, and subagents come in Phases 3–4.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ProfileName } from "./core/types.ts";
import { PermissionStorage, getBaselineRules } from "./core/permissions/index.ts";
import { loadGlobalRules } from "./core/global-config.ts";
import { checkBashPermission, checkFileTarget } from "./core/check.ts";

/** Rules active for this session: baseline + global + persisted + session. */
function activeRules(storage: PermissionStorage): ReturnType<PermissionStorage["getAllRules"]> {
  return storage.getAllRules();
}

export default function safetynetOmp(pi: ExtensionAPI) {
  pi.setLabel("safetynet");

  let storage: PermissionStorage | undefined;

  // Phase 2 runs rules-only with full-access semantics; profiles land in Phase 3.
  const profile: ProfileName = "build";

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    storage = new PermissionStorage(ctx.cwd);
    await storage.init();
    ctx.ui.setStatus("safetynet", "rules on");
  });

  pi.on("session_shutdown", async () => {
    storage = undefined;
  });

  pi.on("tool_call", async (event) => {
    if (!storage) return; // no session yet — fail open like pre-init pi behavior

    const rules = activeRules(storage);

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      if (!command) return;
      const result = checkBashPermission(command, profile, rules, process.cwd());
      if (result.action === "allow") return;
      return {
        block: true,
        reason:
          result.reason ??
          `Blocked pending approval (Phase 2: no interactive prompt yet). Unapproved: ${
            (result.unapproved ?? []).join("; ") || "see command"
          }`,
      };
    }

    // File-writing / reading tools: check declared path targets.
    const fileTools: Record<string, "read" | "edit"> = {
      read: "read",
      edit: "edit",
      write: "edit",
    };
    const perm = fileTools[event.toolName];
    if (!perm) return;

    const input = event.input as Record<string, unknown>;
    const paths: string[] = [];
    if (typeof input.path === "string") paths.push(input.path);
    if (Array.isArray(input.paths)) {
      for (const p of input.paths) if (typeof p === "string") paths.push(p);
    }
    if (paths.length === 0) return;

    for (const path of paths) {
      const result = checkFileTarget(path, perm, profile, rules, process.cwd());
      if (result.action !== "allow") {
        return {
          block: true,
          reason: result.reason ?? `Blocked pending approval: ${perm} ${path}`,
        };
      }
    }
  });
}
