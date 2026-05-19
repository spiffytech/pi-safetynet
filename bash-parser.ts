import { parse } from "@aliou/sh";
import type {
  SimpleCommand,
  CmdSubst,
  ProcSubst,
  WordPart,
  Command,
  TestClause as TestClauseType,
  Word,
} from "@aliou/sh";

/** Threshold (chars) beyond which a quoted string is considered "opaque"
 *  and collapsed to a placeholder.  Strings at or below this length that
 *  contain no newlines are kept verbatim for readability. */
const OPAQUE_STRING_THRESHOLD = 40;

function isOpaqueString(value: string): boolean {
  return value.includes("\n") || value.length > OPAQUE_STRING_THRESHOLD;
}

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
  if (!w?.parts?.length) return null;
  return w.parts
    .map((p: WordPart) => {
      if (p.type === "Literal") return p.value ?? "";
      if (p.type === "SglQuoted") {
        const v = p.value ?? "";
        return isOpaqueString(v) ? "'...'" : v;
      }
      if (p.type === "DblQuoted") {
        const literal = dblQuotedToString(p);
        if (literal !== null) return isOpaqueString(literal) ? '"..."' : literal;
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
type TestCallback = (expr: string, words: Word[]) => void;

function walkCommands(cmd: Command, onSimple: SimpleCallback, onTest?: TestCallback): void {
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
    // @aliou/sh parses [[ ... ]] as TestClause instead of SimpleCommand.
    // Reconstruct the expression string so it shows up as a subcommand
    // (e.g. "[[ -f package.json ]]") and pass the raw words for
    // file-path extraction.
    case "TestClause": {
      if (onTest) {
        const tc = cmd as TestClauseType;
        const parts: string[] = [];
        for (const w of tc.expr ?? []) {
          const s = wordToString(w);
          if (s !== null) parts.push(s);
        }
        if (parts.length) onTest(`[[ ${parts.join(" ")} ]]`, tc.expr ?? []);
      }
      break;
    }
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

/** Replace standalone {} tokens (not inside quotes) with "{}" so that
 *  @aliou/sh doesn't misparse them as empty brace groups.
 *  A character-by-character walk tracks quote state to avoid modifying
 *  {} that appears inside single- or double-quoted strings.
 */
function quoteBraces(cmd: string): string {
  let result = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i]!;

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      result += ch;
      i++;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      result += ch;
      i++;
    } else if (
      ch === "{" && !inSingleQuote && !inDoubleQuote
      && i + 1 < cmd.length && cmd[i + 1] === "}"
    ) {
      // Check that {} is a standalone token (bounded by whitespace or string
      // boundaries).  This avoids replacing {} inside -I{} or similar.
      const prevOk = i === 0 || /\s/.test(cmd[i - 1]!);
      const nextIdx = i + 2;
      const nextOk = nextIdx >= cmd.length || /\s/.test(cmd[nextIdx]!);
      if (prevOk && nextOk) {
        result += '"{}"';
        i += 2;
      } else {
        result += ch;
        i++;
      }
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}

const PROTECTED_DIRS = new Set(
  "/ /usr /usr/local /usr/bin /usr/lib /usr/sbin /usr/share /etc /var /bin /sbin /lib /lib64 /boot /sys /proc /dev /root /opt /home /srv /snap /tmp".split(" "),
);

/** Device files that are always safe to use as redirect targets.
 *  Writing to these is a no-op (e.g., /dev/null) or read-only (e.g.,
 *  /dev/urandom), so they should not be treated as edit-like redirects. */
const SAFE_DEVICE_FILES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/urandom",
  "/dev/random",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/full",
]);

// File-test operators that take a single path argument (unary).
// Used by both [ (test) and [[ to detect file reads.
const UNARY_FILE_TEST_OPS = new Set([
  "-f", "-e", "-d", "-r", "-s", "-L", "-w", "-x", "-h",
  "-O", "-G", "-N", "-k", "-g", "-u",
]);

// Binary operators where both operands are file paths.
const BINARY_FILE_OPS = new Set(["-ef", "-nt", "-ot"]);

// Extract file paths from the word list of a [ or [[ expression.
// Returns paths that are arguments to file-test operators so they can
// be tracked as read targets (i.e. "[ -f /etc/passwd ]" reads /etc/passwd).
function extractTestFilePaths(words: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    // Skip the opening [[ and closing ]] or trailing ]
    if (w === "[[" || w === "]]" || w === "]") continue;
    if (w === "!") continue;
    if (UNARY_FILE_TEST_OPS.has(w)) {
      const next = words[i + 1];
      if (next && next !== "]" && next !== "]]" && !next.startsWith("-")) {
        paths.push(next);
        i++;
      }
    } else if (BINARY_FILE_OPS.has(w)) {
      // Both operands are file paths
      const left = words[i - 1];
      const right = words[i + 1];
      if (left && left !== "[" && left !== "[[") paths.push(left);
      if (right && right !== "]" && right !== "]]") {
        paths.push(right);
        i++;
      }
    }
  }
  return [...new Set(paths)];
}

const SUDO_FLAGS_WITH_ARGS = new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "-T", "-R"]);

// xargs short flags that consume the next word as their argument.
// (Flags like -e, -i, -l have optional concatenated args and don't consume
// a separate word; --long-flags embed the value after =.)
const XARGS_FLAGS_WITH_ARGS = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]);

/** Starting at `start` in `words`, skip past xargs options and return the
 *  index of the first non-option word (the inner command). */
function skipXargsFlags(words: Word[], start: number): number {
  let i = start;
  while (i < words.length) {
    const w = wordToString(words[i]!);
    if (!w) { i++; continue; }
    // -- ends option processing; the next word is the command.
    if (w === "--") { i++; break; }
    // Long options: value is either after = or not present.
    if (w.startsWith("--")) { i++; continue; }
    // Short options
    if (w.startsWith("-")) {
      if (XARGS_FLAGS_WITH_ARGS.has(w)) { i += 2; continue; }
      i++;
      continue;
    }
    // Non-option word: this is the inner command.
    break;
  }
  return i;
}

/** Convert an array of Words to a space-joined string. */
function wordsToString(words: Word[]): string {
  const parts: string[] = [];
  for (const w of words) {
    const s = wordToString(w);
    if (s !== null) parts.push(s);
  }
  return parts.join(" ");
}

/** Append heredoc / here-string suffixes to a subcommand string.
 *
 *  `<<<` and `<<` redirects carry opaque content (scripts, data) that
 *  is not useful for permission matching but is important context for
 *  the user — they need to see that a command receives stdin input.
 *  We collapse the content to `'...'` so the subcommand reads like
 *  `bun -e <<< '...'` instead of just `bun -e` (content lost) or the
 *  full script body (unusable for editing).
 */
function appendRedirectSuffix(
  subcommand: string,
  redirects: Array<{ op: string; target: Word }> | undefined,
  hasHeredoc: boolean,
): string {
  let suffix = "";
  if (redirects) {
    for (const r of redirects) {
      if (r.op === "<<<") {
        suffix += " <<< '...'";
      } else if (r.op === "<<" || r.op === "<<-") {
        suffix += " << '...'";
      }
    }
  }
  // When the heredoc fallback path (stripHeredocBodies) was used,
  // the << redirect is no longer in the AST, but we know one existed.
  if (hasHeredoc && !suffix.includes("<<")) {
    suffix += " << '...'";
  }
  return suffix ? subcommand + suffix : subcommand;
}

const SYSTEM_HALT_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff", "init"]);

function getBaseWord(cmd: SimpleCommand): string | null {
  const words = cmd.words ?? [];
  let i = 0;

  // Peel off sudo (and its flags)
  if (wordToString(words[0] as Word) === "sudo") {
    let skipNext = false;
    for (i = 1; i < words.length; i++) {
      const w = wordToString(words[i]!);
      if (!w) continue;
      if (skipNext) { skipNext = false; continue; }
      if (w.startsWith("-")) {
        if (SUDO_FLAGS_WITH_ARGS.has(w)) skipNext = true;
        continue;
      }
      break;
    }
  }

  // Peel off xargs (and its flags)
  if (i < words.length && wordToString(words[i] as Word) === "xargs") {
    i = skipXargsFlags(words, i + 1);
  }

  if (i >= words.length) return null;
  return wordToString(words[i] as Word) ?? null;
}

function getNonFlagArgsFromNode(cmd: SimpleCommand): string[] {
  const words = cmd.words ?? [];
  let i = 0;

  // Peel off sudo
  if (wordToString(words[0] as Word) === "sudo") {
    let skipNext = false;
    for (i = 1; i < words.length; i++) {
      const w = wordToString(words[i]!);
      if (!w) continue;
      if (skipNext) { skipNext = false; continue; }
      if (w.startsWith("-")) {
        if (SUDO_FLAGS_WITH_ARGS.has(w)) skipNext = true;
        continue;
      }
      break;
    }
  }

  // Peel off xargs
  if (i < words.length && wordToString(words[i] as Word) === "xargs") {
    i = skipXargsFlags(words, i + 1);
  }

  // Skip the command name itself; collect non-flag args of the inner command
  const args: string[] = [];
  for (i = i + 1; i < words.length; i++) {
    const s = wordToString(words[i]!);
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
  /** True when the command uses heredoc (<<) or here-string (<<<). */
  hasHeredoc: boolean;
}

/**
 * Strip multi-line heredoc bodies from a command string.
 *
 * @aliou/sh throws when it encounters a heredoc body (the lines between
 * `<<DELIM` and the closing `DELIM`). By removing the body and keeping
 * only the opener line (which may also contain redirects and pipes), we
 * let the parser produce a valid AST that captures those constructs.
 *
 * The opener line is preserved minus the `<<[-]?DELIM` token itself —
 * any trailing redirects (`> file`) or pipes (`| tee file`) remain.
 *
 * Here-strings (`<<<`) are left untouched; the parser handles them natively.
 * Uses plain string scanning — no regex.
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const result: string[] = [];
  let skipping = false;
  let delim: string | null = null;

  for (const line of lines) {
    if (skipping) {
      // The closing delimiter appears alone on a line (possibly with
      // leading whitespace for <<- heredocs).
      if (line.trim() === delim) {
        skipping = false;
        delim = null;
      }
      continue;
    }

    // Look for heredoc opener: << or <<- followed by a delimiter word.
    // Skip here-strings (<<<).
    const heredocIdx = line.indexOf("<<");
    if (
      heredocIdx >= 0
      && !(heredocIdx + 2 < line.length && line[heredocIdx + 2] === "<") // not <<<
    ) {
      // Extract the delimiter word after << or <<-
      let rest = line.slice(heredocIdx + 2); // after "<<"
      if (rest.startsWith("-")) rest = rest.slice(1); // skip <<- dash
      rest = rest.trimStart();
      // Strip optional quotes around the delimiter
      if (rest.startsWith('"') || rest.startsWith("'")) {
        const quote = rest[0]!;
        const closeIdx = rest.indexOf(quote, 1);
        if (closeIdx > 0) {
          delim = rest.slice(1, closeIdx);
        } else {
          delim = rest.slice(1).trim(); // unclosed quote — best effort
        }
      } else {
        // Delimiter is the next whitespace-delimited word
        const spaceIdx = rest.search(/\s/);
        delim = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
      }

      if (delim) {
        // Remove the <<[-]?DELIM token, keep the rest of the line
        // (redirects, pipes, etc.)
        const tokenEnd = line.indexOf(delim, heredocIdx) + delim.length;
        const afterToken = line.slice(tokenEnd);
        const opener = line.slice(0, heredocIdx) + afterToken;
        result.push(opener);
        skipping = true;
        continue;
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

export function parseCommand(command: string): ParsedCommand {
  try {
    // @aliou/sh misparses \( and \) as subshell boundaries, but in bash these
    // are escaped parens (literal characters). This is common in `find`
    // expression grouping: find . \( -name "*.ts" -o -name "*.js" \).
    // Replace standalone \( \) with equivalent double-quoted parens
    // before parsing so the parser keeps them as regular word tokens.
    command = command
      .replace(/(?<=^|\s)\\\((?=\s|$)/g, '"("')
      .replace(/(?<=^|\s)\\\)(?=\s|$)/g, '")"');

    // @aliou/sh also misparses standalone {} as an empty brace group (Block),
    // but in the context of xargs and find -exec, {} is a placeholder token.
    // An empty brace group { } is actually a syntax error in bash, so a
    // standalone {} can never be a real brace group.  Replace it with a
    // double-quoted version before parsing so the parser keeps it as a
    // regular word token.
    command = quoteBraces(command);

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
            // <<< / << / <<- are handled via appendRedirectSuffix below
          }
        }

        const name = wordToString(cmd.words?.[0] as Word);
        if (!name) return false;

        if (name === "find") {
          const dangerous = hasFindDangerousFlag(cmd);
          if (dangerous === "exec") {
            subcommands.push(appendRedirectSuffix("find:exec", cmd.redirects, false));
            return true;
          }
          if (dangerous === "delete") {
            subcommands.push(appendRedirectSuffix("find:delete", cmd.redirects, false));
            return false;
          }
        }

        if (isNodeCatastrophic(cmd)) catastrophic = true;

        // Strip xargs (and its flags) from the subcommand so that
        // permissions are checked against the inner command.
        // Keep sudo prefix since sudo commands should always require approval.
        const words = cmd.words ?? [];
        const firstEffective = wordToString(words[0] as Word);

        // Determine where xargs starts (position 0, or after sudo flags)
        let xargsIdx = -1;
        if (firstEffective === "xargs") {
          xargsIdx = 0;
        } else if (firstEffective === "sudo") {
          let skipNext = false;
          for (let si = 1; si < words.length; si++) {
            const sw = wordToString(words[si] as Word);
            if (!sw) continue;
            if (skipNext) { skipNext = false; continue; }
            if (sw.startsWith("-")) {
              if (SUDO_FLAGS_WITH_ARGS.has(sw)) skipNext = true;
              continue;
            }
            if (sw === "xargs") xargsIdx = si;
            break;
          }
        }

        if (xargsIdx >= 0) {
          const innerStart = skipXargsFlags(words, xargsIdx + 1);
          const prefixWords = words.slice(0, xargsIdx); // e.g. [sudo ...]
          const innerWords = words.slice(innerStart);
          const allWords = [...prefixWords, ...innerWords];
          if (allWords.length) {
            subcommands.push(appendRedirectSuffix(wordsToString(allWords), cmd.redirects, false));
          } else {
            // xargs with no command defaults to echo
            subcommands.push("echo");
          }
        } else {
          subcommands.push(appendRedirectSuffix(commandToString(cmd), cmd.redirects, false));
        }

        // [ (test) and [[ check file existence/properties, which
        // constitutes a file read. Extract file paths from test
        // operators so they go through read-permission checks.
        if (name === "[" || name === "[[") {
          const wordStrs = (cmd.words ?? []).map((w: Word) => wordToString(w)).filter((s: string | null): s is string => s !== null);
          for (const p of extractTestFilePaths(wordStrs)) {
            redirects.push({ path: p, direction: "input" });
          }
        }

        return true;
      }, (expr, words) => {
        subcommands.push(expr);
        // Same file-read extraction for [[ TestClause nodes
        const wordStrs = words.map((w) => wordToString(w)).filter((s: string | null): s is string => s !== null);
        for (const p of extractTestFilePaths(wordStrs)) {
          redirects.push({ path: p, direction: "input" });
        }
      });
    }

    return {
      subcommands: [...new Set(subcommands)],
      redirects,
      catastrophic,
      hasHeredoc: false,
    };
  } catch {
    // Parser threw, likely due to a heredoc body.  Strip heredoc bodies
    // and retry so the AST captures redirects and pipelines.
    const stripped = stripHeredocBodies(command);
    try {
      const { ast } = parse(stripped);
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
              // <<< / << / <<- handled via appendRedirectSuffix below
            }
          }

          const name = wordToString(cmd.words?.[0] as Word);
          if (!name) return false;

          if (name === "find") {
            const dangerous = hasFindDangerousFlag(cmd);
            if (dangerous === "exec") {
              subcommands.push(appendRedirectSuffix("find:exec", cmd.redirects, true));
              return true;
            }
            if (dangerous === "delete") {
              subcommands.push(appendRedirectSuffix("find:delete", cmd.redirects, true));
              return false;
            }
          }

          if (isNodeCatastrophic(cmd)) catastrophic = true;

          const words = cmd.words ?? [];
          const firstEffective = wordToString(words[0] as Word);

          let xargsIdx = -1;
          if (firstEffective === "xargs") {
            xargsIdx = 0;
          } else if (firstEffective === "sudo") {
            let skipNext = false;
            for (let si = 1; si < words.length; si++) {
              const sw = wordToString(words[si] as Word);
              if (!sw) continue;
              if (skipNext) { skipNext = false; continue; }
              if (sw.startsWith("-")) {
                if (SUDO_FLAGS_WITH_ARGS.has(sw)) skipNext = true;
                continue;
              }
              if (sw === "xargs") xargsIdx = si;
              break;
            }
          }

          if (xargsIdx >= 0) {
            const innerStart = skipXargsFlags(words, xargsIdx + 1);
            const prefixWords = words.slice(0, xargsIdx);
            const innerWords = words.slice(innerStart);
            const allWords = [...prefixWords, ...innerWords];
            if (allWords.length) {
              subcommands.push(appendRedirectSuffix(wordsToString(allWords), cmd.redirects, true));
            } else {
              subcommands.push("echo");
            }
          } else {
            subcommands.push(appendRedirectSuffix(commandToString(cmd), cmd.redirects, true));
          }

          if (name === "[" || name === "[[") {
            const wordStrs = (cmd.words ?? []).map((w: Word) => wordToString(w)).filter((s: string | null): s is string => s !== null);
            for (const p of extractTestFilePaths(wordStrs)) {
              redirects.push({ path: p, direction: "input" });
            }
          }

          return true;
        }, (expr, words) => {
          subcommands.push(appendRedirectSuffix(expr, undefined, true));
          const wordStrs = words.map((w) => wordToString(w)).filter((s: string | null): s is string => s !== null);
          for (const p of extractTestFilePaths(wordStrs)) {
            redirects.push({ path: p, direction: "input" });
          }
        });
      }

      return {
        subcommands: [...new Set(subcommands)],
        redirects,
        catastrophic,
        hasHeredoc: true,
      };
    } catch {
      const first = command.trim().split(/\s+/)[0] ?? "";
      return {
        subcommands: first ? [first] : [],
        redirects: [],
        catastrophic: first ? SYSTEM_HALT_COMMANDS.has(first) : false,
        hasHeredoc: true,
      };
    }
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

/**
 * Detect bash commands that effectively perform file edits — the moral
 * equivalent of the `edit` or `write` tools.  Used in plan mode to deny
 * these commands outright, just as the edit/write tools are disabled.
 *
 * Categories:
 * 1. Any command with an output redirect (>, >>, &>, etc.) to a non-device
 *    file — writing to a real file via redirect is equivalent to the write
 *    tool. Redirects to safe device files (e.g., /dev/null) are excluded.
 * 2. Commands with in-place edit flags: `sed -i`, `perl -pi`/`perl -pe`.
 * 3. Commands whose primary purpose is writing files: `tee`, `truncate`,
 *    `install`, `dd`.
 * 4. Interpreter one-liner invocations (`python -c`, `node -e`, etc.)
 *    that can embed arbitrary file I/O in code strings.
 * 5. Shell invocation of subcommands (`sh -c`, `bash -c`) that can embed
 *    redirects or write commands in the code string.
 */
export function isEditLikeBashCommand(
  command: string,
  parsed: ParsedCommand,
): boolean {
  // 1. Any output redirect detected by the parser or the heredoc fallback
  //    (excluding redirects to safe device files like /dev/null)
  if (parsed.redirects.some((r) => r.direction === "output" && !SAFE_DEVICE_FILES.has(r.path))) return true;

  // 2. Heredoc / here-string with redirect or pipe in raw command
  //    (handled by parseCommand()'s heredoc fallback, which populates
  //    parsed.redirects and parsed.subcommands — checked by #1 and #4 above)
  //    No separate regex scan needed here.

  // 3. In-place edit flags
  for (const sub of parsed.subcommands) {
    // sed -i, sed -i.bak, sed --in-place
    if (/^sed\s/.test(sub) && /\s-i\b|\s-i\.|\s--in-place/.test(sub)) return true;
    // perl -pi, perl -pe  (in-place edit flags)
    if (/^perl\s/.test(sub) && /\s-p[ie]\b|\s-p[ie]\s/.test(sub)) return true;
  }

  // 4. Write-purpose commands
  for (const sub of parsed.subcommands) {
    const baseCmd = sub.trim().split(/\s+/)[0]!;
    if (baseCmd === "tee") return true;
    if (baseCmd === "truncate") return true;
    if (baseCmd === "install") return true;
    if (baseCmd === "dd") return true;
  }

  // 5. Interpreter one-liner invocations that can embed arbitrary file I/O
  for (const sub of parsed.subcommands) {
    const parts = sub.trim().split(/\s+/);
    const base = parts[0]!;
    // python[3] -c, node -e, ruby -e, perl -e, php -r
    if (/^(python3?|node|ruby|perl|php)$/.test(base)) {
      if (parts.some((p) => p === "-c" || p === "-e" || p === "-r")) return true;
    }
    // sh/bash/dash/zsh -c  (subshell execution with code string)
    if (/^(sh|bash|dash|zsh)$/.test(base)) {
      if (parts.some((p) => p === "-c")) return true;
    }
  }

  return false;
}
