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

// =============================================================================
// Bash Confirmation
// =============================================================================

async function confirmBashCommand(
  command: string,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined> {
  if (!ctx.hasUI) {
    return { block: true, reason: "Cannot confirm bash command without UI" };
  }

  let commands = getAllCommands(command);
  commands = Array.from(new Set(commands));

  const confirmed = await ctx.ui.confirm(
    "Confirm Bash Command",
    `Command will execute: ${command}\n\nParsed commands: ${commands.join(", ")}`,
  );

  if (!confirmed) {
    ctx.ui.notify("Bash command blocked by user", "warning");
    ctx.abort();
    return { block: true, reason: "User denied bash command" };
  }
}

/**
 * Extension entrypoint
 */
const spfyExtension = (pi: ExtensionAPI) => {
  pi.on("tool_call", async (event, ctx) => {
    // Path protection for write/edit tools
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path as string;

      //if (!isProtectedPath(path)) {
      //  return undefined;
      //}

      const confirmed = await ctx.ui.confirm(
        "Confirm File Edit",
        "Do you want to apply this edit?",
      );

      if (!confirmed) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked write to protected path: ${path}`, "warning");
        }
        ctx.abort();
        return { block: true, reason: `Path "${path}" is protected` };
      }
    }

    // Bash command confirmation
    if (isToolCallEventType("bash", event)) {
      return confirmBashCommand(event.input.command, ctx);
    }
  });
};

export default spfyExtension;
