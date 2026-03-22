import { parse, type SimpleCommand } from "@aliou/sh";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Path Protection
// =============================================================================

const protectedPaths = [".env", ".git/", "node_modules/"];

function isProtectedPath(path: string): boolean {
  return protectedPaths.some((p) => path.includes(p));
}

// =============================================================================
// Shell Command Parsing
// =============================================================================

/**
 * This is taken straight out of the @aliou/sh README
 */
function extractCommandNames(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as Record<string, unknown>;
  const names: string[] = [];

  if (n.type === "SimpleCommand") {
    const cmd = n as unknown as SimpleCommand;
    if (cmd.words?.length) {
      const first = cmd.words[0];
      if (first.parts?.length) {
        const cmdName = first.parts
          .map((p: { type: string; value?: string }) =>
            p.type === "Literal" ? (p.value ?? "") : "",
          )
          .join("");
        if (cmdName) names.push(cmdName);
      }
    }
  }

  for (const val of Object.values(n)) {
    if (Array.isArray(val)) {
      for (const item of val) names.push(...extractCommandNames(item));
    } else if (val && typeof val === "object") {
      names.push(...extractCommandNames(val));
    }
  }
  return names;
}

function getAllCommands(command: string): string[] {
  const { ast } = parse(command);
  return extractCommandNames(ast);
}

/**
 * Shows a confirmation dialog with options and returns the result.
 * Options should include "Allow once", "Allow always", and "Block".
 * Returns a binary allowed/block result plus whether "always" was selected.
 */
async function confirmWithOptions(
  ctx: ExtensionContext,
  message: string,
  options: string[] = ["Allow once", "Allow always", "Block"],
): Promise<{ allowed: boolean; always: boolean }> {
  if (!ctx.hasUI) {
    return { allowed: false, always: false };
  }

  const choice = await ctx.ui.select(message, options);

  if (choice === undefined || choice === options[options.length - 1]) {
    // User cancelled or chose the last option (Block)
    return { allowed: false, always: false };
  }

  const always = choice === options[1]; // "Allow always" is typically second
  return { allowed: true, always };
}

// =============================================================================
// Bash Confirmation
// =============================================================================

async function confirmBashCommand(
  command: string,
  ctx: ExtensionContext,
  alwaysAllow: string[],
  allowCommands: (commands: string[]) => void,
): Promise<{ block: true; reason: string } | undefined> {
  let commands = getAllCommands(command);
  commands = Array.from(new Set(commands));
  commands = commands.filter((command) => !alwaysAllow.includes(command));
  if (commands.length === 0) return;

  const result = await confirmWithOptions(
    ctx,
    `Command will execute: ${command}\n\nParsed commands: ${commands.join(", ")}`,
  );

  if (!result.allowed) {
    ctx.ui.notify("Bash command blocked by user", "warning");
    ctx.abort();
    return { block: true, reason: "User denied bash command" };
  }

  if (result.always) {
    allowCommands(commands);
  }
}

/**
 * Extension entrypoint
 */
const spfyExtension = (pi: ExtensionAPI) => {
  let allowedPaths: string[] = [];
  let allowedCommands: string[] = [];

  const reconstruct = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === "spfy:alwaysAllow:files"
      ) {
        allowedPaths = entry.data as typeof allowedPaths;
      }
      if (
        entry.type === "custom" &&
        entry.customType === "spfy:alwaysAllow:commands"
      ) {
        allowedCommands = entry.data as typeof allowedCommands;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstruct(ctx));

  pi.on("tool_call", async (event, ctx) => {
    // Path protection for write/edit tools
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path as string;

      if (allowedPaths.includes(path)) return;

      // Skip confirmation for edits where oldText doesn't match (app will retry)
      if (event.toolName === "edit") {
        const fs = await import("fs/promises");
        const oldText = event.input.oldText as string;
        const content = await fs.readFile(path, "utf-8");
        if (!content.includes(oldText)) {
          ctx.ui.notify("Edit conflict - skipping confirmation", "warning");
          return;
        }
      }

      const result = await confirmWithOptions(
        ctx,
        "Do you want to apply this edit?",
      );

      if (!result.allowed) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
        }
        ctx.abort();
        return { block: true, reason: `Path "${path}" is protected` };
      }

      if (result.always) {
        allowedPaths.push(path);
        pi.appendEntry("spfy:alwaysAllow:files", allowedPaths);
      }
    }

    // Bash command confirmation
    if (isToolCallEventType("bash", event)) {
      return confirmBashCommand(
        event.input.command,
        ctx,
        allowedCommands,
        (commands) => {
          allowedCommands.push(...commands);
          pi.appendEntry("spfy:alwaysAllow:commands", allowedCommands);
        },
      );
    }
  });
};

export default spfyExtension;
