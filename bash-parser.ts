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

function getCommandName(cmd: SimpleCommand): string | null {
  if (!cmd.words?.length) return null;
  const first = cmd.words[0];
  return wordToString(first);
}

function wordToString(w: Word): string | null {
  if (!w.parts?.length) return null;
  return w.parts
    .map((p: WordPart) => {
      if (p.type === "Literal" || p.type === "SglQuoted") return p.value ?? "";
      if (p.type === "DblQuoted") return '"..."';
      if (p.type === "ParamExp") return "${...}";
      if (p.type === "CmdSubst") return "$(...)";
      if (p.type === "ArithExp") return "$((...))";
      if (p.type === "ProcSubst") return p.op === "<" ? "<(...)" : ">(...)";
      return "";
    })
    .join("");
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

function commandToString(cmd: SimpleCommand): string {
  const parts: string[] = [];
  for (const w of cmd.words ?? []) {
    const s = wordToString(w);
    if (s !== null) parts.push(s);
  }
  return parts.join(" ");
}

function hasFindExecFlag(cmd: SimpleCommand): boolean {
  const args = getCommandArgs(cmd);
  return args.some((a) => a === "-exec" || a === "-execdir");
}

function extractSubcommandsFromStatement(stmt: Statement): string[] {
  const commands: string[] = [];
  collectSubcommands(stmt.command, commands);
  return commands;
}

function collectSubcommands(cmd: Command, out: string[]): void {
  switch (cmd.type) {
    case "SimpleCommand": {
      const name = getCommandName(cmd);
      if (!name) break;

      if (name === "find" && hasFindExecFlag(cmd)) {
        out.push(commandToString(cmd));
        break;
      }

      out.push(name);

      if (cmd.redirects?.length) {
        for (const r of cmd.redirects) {
          if (r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>") {
            const target = wordToString(r.target);
            if (target) out.push(`>${target}`);
          }
        }
      }

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

export function hasFileRedirects(command: string): boolean {
  try {
    const { ast } = parse(command);
    for (const stmt of ast.body) {
      if (stmtHasRedirects(stmt)) return true;
    }
    return false;
  } catch {
    return /[12]?>[^&]/.test(command) || />>/.test(command);
  }
}

function stmtHasRedirects(stmt: Statement): boolean {
  const cmd = stmt.command;

  if (cmd.type === "SimpleCommand" && cmd.redirects?.length) {
    for (const r of cmd.redirects) {
      if (
        r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" ||
        r.op === ">|" || r.op === "<>"
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

export function isCatastrophicCommand(command: string): boolean {
  const patterns = [
    /\brm\s+-rf\s+\/\s*$/,
    /\brm\s+-rf\s+\/\*/,
    /\brm\s+-rf\s+~/,
    /\bsudo\s+rm\s+-rf\s+\/\*/,
    /\bmkfs\./,
    /\bdd\s+if=/,
    /\bsudo\s+rm\s+-rf\s+--no-preserve-root/,
  ];
  return patterns.some((p) => p.test(command));
}

export function isHazardousFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;

  const allowed = [".env.example", ".env.sample", ".env.template", ".sample.env"];
  if (allowed.some((e) => filePath.endsWith(e))) return false;

  if (/^\.env(\.[^.]+)?$/.test(basename)) return true;

  if (/\.ssh[\\/]/.test(filePath)) return true;
  if (/\.gnupg[\\/]/.test(filePath)) return true;
  if (/\.aws[\\/]credentials/.test(filePath)) return true;

  return false;
}
