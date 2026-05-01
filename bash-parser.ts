import { parse } from "@aliou/sh";
import type {
  SimpleCommand,
  Statement,
  CmdSubst,
  ProcSubst,
  Pipeline,
  Logical,
  Redirect,
  WordPart,
  Command,
  Word,
} from "@aliou/sh";

function dblQuotedToString(p: WordPart): string | null {
  const parts = (p as { type: "DblQuoted"; parts: WordPart[] }).parts;
  if (!parts?.length) return "";
  const hasExpansion = parts.some(
    (sp) => sp.type !== "Literal" && sp.type !== "SglQuoted",
  );
  if (hasExpansion) return null;
  return parts.map((sp) => sp.value ?? "").join("");
}

function wordToString(w: Word): string | null {
  if (!w.parts?.length) return null;
  return w.parts
    .map((p: WordPart) => {
      if (p.type === "Literal" || p.type === "SglQuoted") return p.value ?? "";
      if (p.type === "DblQuoted") {
        const literal = dblQuotedToString(p);
        if (literal !== null) return literal;
        return '"..."';
      }
      if (p.type === "ParamExp") return "${...}";
      if (p.type === "CmdSubst") return "$(...)";
      if (p.type === "ArithExp") return "$((...))";
      if (p.type === "ProcSubst") return p.op === "<" ? "<(...)" : ">(...)";
      return "";
    })
    .join("");
}

function commandToString(cmd: SimpleCommand): string {
  const parts: string[] = [];
  for (const w of cmd.words ?? []) {
    const s = wordToString(w);
    if (s !== null) parts.push(s);
  }
  return parts.join(" ");
}

function getCommandArgs(cmd: SimpleCommand): string[] {
  const args: string[] = [];
  if (!cmd.words?.length) return args;
  for (let i = 1; i < cmd.words.length; i++) {
    const s = wordToString(cmd.words[i]);
    if (s !== null) args.push(s);
  }
  return args;
}

function hasFindDangerousFlag(cmd: SimpleCommand): "exec" | "delete" | null {
  const args = getCommandArgs(cmd);
  if (args.some((a) => a === "-exec" || a === "-execdir")) return "exec";
  if (args.some((a) => a === "-delete")) return "delete";
  return null;
}

function extractSubcommandsFromStatement(stmt: Statement): string[] {
  const commands: string[] = [];
  collectSubcommands(stmt.command, commands);
  return commands;
}

function collectSubcommands(cmd: Command, out: string[]): void {
  switch (cmd.type) {
    case "SimpleCommand": {
      const name = wordToString(cmd.words?.[0] as Word);
      if (!name) break;

      if (name === "find") {
        const dangerous = hasFindDangerousFlag(cmd);
        if (dangerous === "exec") {
          out.push("find:exec");
          for (const w of cmd.words ?? []) {
            if (!w.parts) continue;
            for (const p of w.parts) collectFromWordPart(p, out);
          }
          break;
        }
        if (dangerous === "delete") {
          out.push("find:delete");
          break;
        }
      }

      out.push(commandToString(cmd));

      for (const w of cmd.words ?? []) {
        if (!w.parts) continue;
        for (const p of w.parts) {
          collectFromWordPart(p, out);
        }
      }
      break;
    }

    case "Pipeline":
      for (const s of cmd.commands) collectSubcommands(s.command, out);
      break;

    case "Logical":
      collectSubcommands(cmd.left.command, out);
      collectSubcommands(cmd.right.command, out);
      break;

    case "Subshell":
    case "Block":
      for (const s of cmd.body) collectSubcommands(s.command, out);
      break;

    case "IfClause":
      for (const s of cmd.cond) collectSubcommands(s.command, out);
      for (const s of cmd.then) collectSubcommands(s.command, out);
      if (cmd.else) for (const s of cmd.else) collectSubcommands(s.command, out);
      break;

    case "WhileClause":
      for (const s of cmd.cond) collectSubcommands(s.command, out);
      for (const s of cmd.body) collectSubcommands(s.command, out);
      break;

    case "ForClause":
    case "SelectClause":
      for (const s of cmd.body) collectSubcommands(s.command, out);
      break;

    case "FunctionDecl":
      for (const s of cmd.body) collectSubcommands(s.command, out);
      break;

    case "CaseClause":
      for (const item of cmd.items) {
        for (const s of item.body) collectSubcommands(s.command, out);
      }
      break;

    case "TimeClause":
      collectSubcommands(cmd.command.command, out);
      break;

    case "CoprocClause":
      collectSubcommands(cmd.body.command, out);
      break;

    case "DeclClause":
      if (cmd.assigns) {
        for (const a of cmd.assigns) {
          if (a.value) collectFromWord(a.value, out);
        }
      }
      break;

    default:
      break;
  }
}

function collectFromWordPart(part: WordPart, out: string[]): void {
  if (part.type === "CmdSubst") {
    for (const s of (part as CmdSubst).stmts) {
      collectSubcommands(s.command, out);
    }
  } else if (part.type === "ProcSubst") {
    for (const s of (part as ProcSubst).stmts) {
      collectSubcommands(s.command, out);
    }
  } else if (part.type === "DblQuoted") {
    for (const p of (part as { type: "DblQuoted"; parts: WordPart[] }).parts) {
      collectFromWordPart(p, out);
    }
  }
}

function collectFromWord(w: Word, out: string[]): void {
  for (const p of w.parts ?? []) {
    collectFromWordPart(p, out);
  }
}

export function getAllCommands(command: string): string[] {
  try {
    const { ast } = parse(command);
    const commands: string[] = [];
    for (const stmt of ast.body) {
      commands.push(...extractSubcommandsFromStatement(stmt));
    }
    return [...new Set(commands)];
  } catch {
    const first = command.trim().split(/\s+/)[0] ?? "";
    return first ? [first] : [];
  }
}

export interface RedirectTarget {
  path: string;
  direction: "input" | "output";
}

export function getRedirectTargets(command: string): RedirectTarget[] {
  try {
    const { ast } = parse(command);
    const targets: RedirectTarget[] = [];
    for (const stmt of ast.body) {
      collectRedirectTargets(stmt.command, targets);
    }
    return targets;
  } catch {
    return [];
  }
}

function collectRedirectTargets(cmd: Command, out: RedirectTarget[]): void {
  switch (cmd.type) {
    case "SimpleCommand":
      if (cmd.redirects?.length) {
        for (const r of cmd.redirects) {
          const target = wordToString(r.target);
          if (!target) continue;
          if (r.op === "<") {
            out.push({ path: target, direction: "input" });
          } else if (r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" || r.op === ">|" || r.op === "<>") {
            out.push({ path: target, direction: "output" });
          }
        }
      }
      for (const w of cmd.words ?? []) {
        if (!w.parts) continue;
        for (const p of w.parts) {
          if (p.type === "CmdSubst" || p.type === "ProcSubst" || p.type === "DblQuoted") {
            collectFromWordPartRedirect(p, out);
          }
        }
      }
      break;
    case "Pipeline":
      for (const s of cmd.commands) collectRedirectTargets(s.command, out);
      break;
    case "Logical":
      collectRedirectTargets(cmd.left.command, out);
      collectRedirectTargets(cmd.right.command, out);
      break;
    case "Subshell":
    case "Block":
      for (const s of cmd.body) collectRedirectTargets(s.command, out);
      break;
    default:
      break;
  }
}

function collectFromWordPartRedirect(part: WordPart, out: RedirectTarget[]): void {
  if (part.type === "CmdSubst") {
    for (const s of (part as CmdSubst).stmts) {
      collectRedirectTargets(s.command, out);
    }
  } else if (part.type === "ProcSubst") {
    for (const s of (part as ProcSubst).stmts) {
      collectRedirectTargets(s.command, out);
    }
  } else if (part.type === "DblQuoted") {
    for (const p of (part as { type: "DblQuoted"; parts: WordPart[] }).parts) {
      collectFromWordPartRedirect(p, out);
    }
  }
}

export function hasFileRedirects(command: string): boolean {
  try {
    const { ast } = parse(command);
    for (const stmt of ast.body) {
      if (stmtHasRedirects(stmt)) return true;
    }
    return false;
  } catch {
    return /[12]?>[^&]/.test(command) || />>/.test(command) || /<(?![<(])/.test(command);
  }
}

function stmtHasRedirects(stmt: Statement): boolean {
  const cmd = stmt.command;

  if (cmd.type === "SimpleCommand" && cmd.redirects?.length) {
    for (const r of cmd.redirects) {
      if (
        r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" ||
        r.op === ">|" || r.op === "<>" || r.op === "<"
      ) {
        return true;
      }
    }
  }

  switch (cmd.type) {
    case "Subshell":
    case "Block":
      return cmd.body.some(stmtHasRedirects);
    case "IfClause":
      return [...cmd.cond, ...cmd.then, ...(cmd.else ?? [])].some(stmtHasRedirects);
    case "WhileClause":
    case "ForClause":
      return [...cmd.cond, ...cmd.body].some(stmtHasRedirects);
    case "CaseClause":
      return cmd.items.flatMap((item: { body: Statement[] }) => item.body).some(stmtHasRedirects);
    case "Pipeline":
      return cmd.commands.some(stmtHasRedirects);
    case "Logical":
      return stmtHasRedirects(cmd.left) || stmtHasRedirects(cmd.right);
    default:
      return false;
  }
}

const PROTECTED_DIRS = new Set([
  "/",
  "/usr",
  "/usr/local",
  "/usr/bin",
  "/usr/lib",
  "/usr/sbin",
  "/usr/share",
  "/etc",
  "/var",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/sys",
  "/proc",
  "/dev",
  "/root",
  "/opt",
  "/home",
  "/srv",
  "/snap",
  "/tmp",
]);

function getNonFlagArgs(command: string): string[] {
  try {
    const { ast } = parse(command);
    const args: string[] = [];
    for (const stmt of ast.body) {
      collectNonFlagArgs(stmt.command, args);
    }
    return args;
  } catch {
    const tokens = command.trim().split(/\s+/);
    return tokens.slice(1).filter((t) => !t.startsWith("-"));
  }
}

function collectNonFlagArgs(cmd: Command, out: string[]): void {
  switch (cmd.type) {
    case "SimpleCommand": {
      const firstWord = wordToString(cmd.words?.[0] as Word);
      const start = firstWord === "sudo" ? 2 : 1;
      for (let i = start; i < (cmd.words?.length ?? 0); i++) {
        const s = wordToString(cmd.words![i]);
        if (s !== null && !s.startsWith("-")) out.push(s);
      }
      break;
    }
    case "Pipeline":
      for (const s of cmd.commands) collectNonFlagArgs(s.command, out);
      break;
    case "Logical":
      collectNonFlagArgs(cmd.left.command, out);
      collectNonFlagArgs(cmd.right.command, out);
      break;
    case "Subshell":
    case "Block":
      for (const s of cmd.body) collectNonFlagArgs(s.command, out);
      break;
    default:
      break;
  }
}

function getFirstWord(command: string): string | null {
  try {
    const { ast } = parse(command);
    for (const stmt of ast.body) {
      const cmd = stmt.command;
      if (cmd.type === "SimpleCommand" && cmd.words?.length) {
        return wordToString(cmd.words[0] as Word);
      }
    }
    return null;
  } catch {
    const tokens = command.trim().split(/\s+/);
    return tokens[0] ?? null;
  }
}

const SUDO_FLAGS_WITH_ARGS = new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "-T", "-R"]);

function getBaseCommand(command: string): string | null {
  try {
    const { ast } = parse(command);
    for (const stmt of ast.body) {
      const cmd = stmt.command;
      if (cmd.type === "SimpleCommand" && cmd.words?.length) {
        const firstWord = wordToString(cmd.words[0] as Word);
        if (firstWord !== "sudo") return firstWord;
        let skipNext = false;
        for (let i = 1; i < cmd.words.length; i++) {
          const w = wordToString(cmd.words[i] as Word);
          if (!w) continue;
          if (skipNext) {
            skipNext = false;
            continue;
          }
          if (w.startsWith("-")) {
            if (SUDO_FLAGS_WITH_ARGS.has(w)) skipNext = true;
            continue;
          }
          return w;
        }
        return null;
      }
    }
    return null;
  } catch {
    const tokens = command.trim().split(/\s+/);
    if (tokens[0] === "sudo") {
      let skipNext = false;
      for (let i = 1; i < tokens.length; i++) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (tokens[i]!.startsWith("-")) {
          if (SUDO_FLAGS_WITH_ARGS.has(tokens[i]!)) skipNext = true;
          continue;
        }
        return tokens[i] ?? null;
      }
      return null;
    }
    return tokens[0] ?? null;
  }
}

const SYSTEM_HALT_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff", "init"]);

function isSingleCmdCatastrophic(command: string): boolean {
  const baseCmd = getBaseCommand(command);

  if (baseCmd && SYSTEM_HALT_COMMANDS.has(baseCmd)) return true;
  if (baseCmd && /^mkfs\.?/.test(baseCmd)) return true;
  if (baseCmd === "dd" && /of=\/dev\//.test(command)) return true;
  if (baseCmd === "rm" && /--no-preserve-root/.test(command)) return true;

  if (baseCmd === "rm" || baseCmd === "chmod" || baseCmd === "chown") {
    const args = getNonFlagArgs(command);
    if (args.some((a) => PROTECTED_DIRS.has(a) || a === "~" || a === "/*" || a.startsWith("$"))) return true;
  }

  return false;
}

export function isCatastrophicCommand(command: string): boolean {
  const subcommands = getAllCommands(command);
  return subcommands.some((cmd) => isSingleCmdCatastrophic(cmd));
}

export function isHazardousFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;

  const allowed = [".env.example", ".env.sample", ".env.template", ".sample.env"];
  if (allowed.some((e) => filePath.endsWith(e))) return false;

  if (/^\.env(\.[^.]+)*$/.test(basename)) return true;
  if (basename === ".envrc") return true;
  if (basename === ".npmrc") return true;
  if (basename === ".pypirc") return true;
  if (basename === ".netrc") return true;
  if (basename === ".dockercfg") return true;

  if (/^id_(rsa|ed25519|ecdsa)$/.test(basename)) return true;
  if (/\.pem$/.test(basename)) return true;

  if (/^credentials\.(json|ya?ml)$/.test(basename)) return true;
  if (/^secrets\.(json|ya?ml)$/.test(basename)) return true;

  if (/\.ssh[\\/]/.test(filePath)) return true;
  if (/\.gnupg[\\/]/.test(filePath)) return true;
  if (/\.aws[\\/]credentials/.test(filePath)) return true;
  if (/\.docker[\\/]config\.json/.test(filePath)) return true;

  return false;
}
