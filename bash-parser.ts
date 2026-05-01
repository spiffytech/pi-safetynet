import { parse } from "@aliou/sh";
import type {
  SimpleCommand,
  CmdSubst,
  ProcSubst,
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

type SimpleCallback = (cmd: SimpleCommand) => boolean;

function walkCommands(cmd: Command, onSimple: SimpleCallback): void {
  switch (cmd.type) {
    case "SimpleCommand": {
      const recurse = onSimple(cmd);
      if (recurse) {
        for (const w of cmd.words ?? []) {
          if (!w.parts) continue;
          for (const p of w.parts) walkWordPart(p, onSimple);
        }
      }
      break;
    }
    case "Pipeline":
      for (const s of cmd.commands) walkCommands(s.command, onSimple);
      break;
    case "Logical":
      walkCommands(cmd.left.command, onSimple);
      walkCommands(cmd.right.command, onSimple);
      break;
    case "Subshell":
    case "Block":
      for (const s of cmd.body) walkCommands(s.command, onSimple);
      break;
    case "IfClause":
      for (const s of cmd.cond) walkCommands(s.command, onSimple);
      for (const s of cmd.then) walkCommands(s.command, onSimple);
      if (cmd.else) for (const s of cmd.else) walkCommands(s.command, onSimple);
      break;
    case "WhileClause":
      for (const s of cmd.cond) walkCommands(s.command, onSimple);
      for (const s of cmd.body) walkCommands(s.command, onSimple);
      break;
    case "ForClause":
    case "SelectClause":
      for (const s of cmd.body) walkCommands(s.command, onSimple);
      break;
    case "FunctionDecl":
      for (const s of cmd.body) walkCommands(s.command, onSimple);
      break;
    case "CaseClause":
      for (const item of cmd.items) {
        for (const s of item.body) walkCommands(s.command, onSimple);
      }
      break;
    case "TimeClause":
      walkCommands(cmd.command.command, onSimple);
      break;
    case "CoprocClause":
      walkCommands(cmd.body.command, onSimple);
      break;
    case "DeclClause":
      if (cmd.assigns) {
        for (const a of cmd.assigns) {
          if (a.value) walkWord(a.value, onSimple);
        }
      }
      break;
    default:
      break;
  }
}

function walkWordPart(part: WordPart, onSimple: SimpleCallback): void {
  if (part.type === "CmdSubst") {
    for (const s of (part as CmdSubst).stmts) {
      walkCommands(s.command, onSimple);
    }
  } else if (part.type === "ProcSubst") {
    for (const s of (part as ProcSubst).stmts) {
      walkCommands(s.command, onSimple);
    }
  } else if (part.type === "DblQuoted") {
    for (const p of (part as { type: "DblQuoted"; parts: WordPart[] }).parts) {
      walkWordPart(p, onSimple);
    }
  }
}

function walkWord(w: Word, onSimple: SimpleCallback): void {
  for (const p of w.parts ?? []) {
    walkWordPart(p, onSimple);
  }
}

const PROTECTED_DIRS = new Set(
  "/ /usr /usr/local /usr/bin /usr/lib /usr/sbin /usr/share /etc /var /bin /sbin /lib /lib64 /boot /sys /proc /dev /root /opt /home /srv /snap /tmp".split(" "),
);

const SUDO_FLAGS_WITH_ARGS = new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "-T", "-R"]);

const SYSTEM_HALT_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff", "init"]);

function getBaseWord(cmd: SimpleCommand): string | null {
  const firstWord = wordToString(cmd.words?.[0] as Word);
  if (!firstWord) return null;
  if (firstWord !== "sudo") return firstWord;
  let skipNext = false;
  for (let i = 1; i < cmd.words!.length; i++) {
    const w = wordToString(cmd.words![i]!);
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

function getNonFlagArgsFromNode(cmd: SimpleCommand): string[] {
  const firstWord = wordToString(cmd.words?.[0] as Word);
  const start = firstWord === "sudo" ? 2 : 1;
  const args: string[] = [];
  for (let i = start; i < (cmd.words?.length ?? 0); i++) {
    const s = wordToString(cmd.words![i]!);
    if (s !== null && !s.startsWith("-")) args.push(s);
  }
  return args;
}

function isNodeCatastrophic(cmd: SimpleCommand): boolean {
  const baseCmd = getBaseWord(cmd);
  if (!baseCmd) return false;

  if (SYSTEM_HALT_COMMANDS.has(baseCmd)) return true;
  if (/^mkfs\.?/.test(baseCmd)) return true;

  const cmdStr = commandToString(cmd);
  if (baseCmd === "dd" && /of=\/dev\//.test(cmdStr)) return true;
  if (baseCmd === "rm" && /--no-preserve-root/.test(cmdStr)) return true;

  if (baseCmd === "rm" || baseCmd === "chmod" || baseCmd === "chown") {
    const args = getNonFlagArgsFromNode(cmd);
    if (args.some((a) => PROTECTED_DIRS.has(a) || a === "~" || a === "/*" || a.startsWith("$"))) return true;
  }

  return false;
}

export interface RedirectTarget {
  path: string;
  direction: "input" | "output";
}

export interface ParsedCommand {
  subcommands: string[];
  redirects: RedirectTarget[];
  catastrophic: boolean;
}

export function parseCommand(command: string): ParsedCommand {
  try {
    const { ast } = parse(command);
    const subcommands: string[] = [];
    const redirects: RedirectTarget[] = [];
    let catastrophic = false;

    for (const stmt of ast.body) {
      walkCommands(stmt.command, (cmd) => {
        if (cmd.redirects?.length) {
          for (const r of cmd.redirects) {
            const target = wordToString(r.target);
            if (!target) continue;
            if (r.op === "<") {
              redirects.push({ path: target, direction: "input" });
            } else if (r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" || r.op === ">|" || r.op === "<>") {
              redirects.push({ path: target, direction: "output" });
            }
          }
        }

        const name = wordToString(cmd.words?.[0] as Word);
        if (!name) return false;

        if (name === "find") {
          const dangerous = hasFindDangerousFlag(cmd);
          if (dangerous === "exec") {
            subcommands.push("find:exec");
            return true;
          }
          if (dangerous === "delete") {
            subcommands.push("find:delete");
            return false;
          }
        }

        if (isNodeCatastrophic(cmd)) catastrophic = true;

        subcommands.push(commandToString(cmd));
        return true;
      });
    }

    return {
      subcommands: [...new Set(subcommands)],
      redirects,
      catastrophic,
    };
  } catch {
    const first = command.trim().split(/\s+/)[0] ?? "";
    return {
      subcommands: first ? [first] : [],
      redirects: [],
      catastrophic: first ? SYSTEM_HALT_COMMANDS.has(first) : false,
    };
  }
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
