import { parse } from "@aliou/sh";
import type {
	SimpleCommand,
	CmdSubst,
	ProcSubst,
	WordPart,
	Command,
	TestClause as TestClauseType,
	TestExpr,
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
        if (v === "") return "''";
        return isOpaqueString(v) ? "'...'" : v;
      }
      if (p.type === "DblQuoted") {
        const literal = dblQuotedToString(p);
        if (literal === null) return '"..."';
        if (literal === "") return '""';
        return isOpaqueString(literal) ? '"..."' : literal;
      }
      if (p.type === "ParamExp") return "${...}";
      if (p.type === "CmdSubst") return "$(...)";
      if (p.type === "ArithExp") return "$((...))";
      if (p.type === "ProcSubst") return p.op === "<" ? "<(...)" : ">(...)";
      return "";
    })
    .join("");
}

/** Display form of a word — like wordToString, but wraps non-opaque
 *  SglQuoted/DblQuoted content in the originating quote chars so the UI
 *  shows the user's original quoting (e.g. `-g "can save a link"`).
 *  Opaque/expansion placeholders ('...' / "...") and empty quotes ('' / "")
 *  are preserved exactly as wordToString produces them.  Mixed words
 *  (e.g. pre"mid"post) wrap each quoted part independently. */
function wordToDisplayString(w: Word): string | null {
  if (!w?.parts?.length) return null;
  return w.parts
    .map((p: WordPart) => {
      if (p.type === "Literal") return p.value ?? "";
      if (p.type === "SglQuoted") {
        const v = p.value ?? "";
        if (v === "") return "''";
        return isOpaqueString(v) ? "'...'" : `'${v}'`;
      }
      if (p.type === "DblQuoted") {
        const literal = dblQuotedToString(p);
        if (literal === null) return '"..."';
        if (literal === "") return '""';
        return isOpaqueString(literal) ? '"..."' : `"${literal}"`;
      }
      if (p.type === "ParamExp") return "${...}";
      if (p.type === "CmdSubst") return "$(...)";
      if (p.type === "ArithExp") return "$((...))";
      if (p.type === "ProcSubst") return p.op === "<" ? "<(...)" : ">(...)";
      return "";
    })
    .join("");
}

/** Test whether a single word token acts as `flag`.  A token matches if it
 *  equals the flag, or is the flag followed by a non-word suffix (so
 *  `-i.bak` matches `-i`, but `-in` does not).  This is the token-boundary
 *  equivalent of the old `\s-i\b` substring regex — a quoted literal like
 *  `"we are -i today"` is a single token whose literal value is the whole
 *  sentence, so it never matches. */
function tokenHasFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (!token.startsWith(flag)) return false;
  const next = token[flag.length];
  return next !== undefined && !/[A-Za-z0-9_]/.test(next);
}

function commandToString(cmd: SimpleCommand): string {
  const parts: string[] = [];
  for (const w of cmd.words ?? []) {
    const s = wordToString(w);
    if (s !== null) parts.push(s);
  }
  return parts.join(" ");
}

/** Display form of a SimpleCommand — joins wordToDisplayString per word,
 *  preserving the user's original quoting for UI display. */
function commandToDisplayString(cmd: SimpleCommand): string {
  const parts: string[] = [];
  for (const w of cmd.words ?? []) {
    const s = wordToDisplayString(w);
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

/** Flatten @aliou/sh 0.2's structured [[ ... ]] tree (UnaryTest / BinaryTest /
 *  ParenTest / Word) into the flat Word list the rest of this module expects:
 *  e.g. "file1 -ef file2" or "-f package.json". Operands are emitted in
 *  source order so extractTestFilePaths() can pair them with their operators
 *  the same way it did when the parser exposed `.expr: Word[]` directly. */
function flattenTestExpr(node: TestExpr): Word[] {
	if (node.type === "Word") return [node];
	if (node.type === "UnaryTest") {
		const x = flattenTestExpr(node.x);
		// Bash unary form is `OP operand`; preserve that order.
		return [{ type: "Word", parts: [{ type: "Literal", value: node.op }] }, ...x];
	}
	if (node.type === "BinaryTest") {
		const x = flattenTestExpr(node.x);
		const y = flattenTestExpr(node.y);
		// "operand OP operand"
		return [...x, { type: "Word", parts: [{ type: "Literal", value: node.op }] }, ...y];
	}
	if (node.type === "ParenTest") {
		// `[[ ( inner ) ]]` — surface the inner expression; parens have no
		// significance for file-path extraction.
		return flattenTestExpr(node.x);
	}
	return [];
}

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
    // @aliou/sh 0.2 parses [[ ... ]] as a TestClause whose operands are a
    // structured tree (UnaryTest / BinaryTest / ParenTest / Word) on `.x`,
    // rather than the flat `.expr: Word[]` of 0.1. Flatten it back to the
    // ordered Word list the rest of this module expects so it shows up as a
    // subcommand (e.g. "[[ -f package.json ]]") and file paths are extracted.
    case "TestClause": {
      if (onTest) {
        const tc = cmd as TestClauseType;
        const words = tc.x ? flattenTestExpr(tc.x) : [];
        const parts: string[] = [];
        for (const w of words) {
          const s = wordToString(w);
          if (s !== null) parts.push(s);
        }
        if (parts.length) onTest(`[[ ${parts.join(" ")} ]]`, words);
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

/** Walks past a sudo + sudo-flags prefix in `words` (starting at index 0)
 *  and returns the index of the first non-sudo word (the effective command).
 *  Mirrors the sudo-peel logic in getBaseWord/getNonFlagArgsFromNode so
 *  the timeout/xargs detection in walkCommands shares one implementation. */
function findEffectiveCommandIdx(words: Word[]): number {
  if (wordToString(words[0] as Word) !== "sudo") return 0;
  let skipNext = false;
  for (let i = 1; i < words.length; i++) {
    const w = wordToString(words[i]!);
    if (!w) continue;
    if (skipNext) { skipNext = false; continue; }
    if (w.startsWith("-")) {
      if (SUDO_FLAGS_WITH_ARGS.has(w)) skipNext = true;
      continue;
    }
    return i;
  }
  return words.length;
}

/** Returns true iff `s` looks like a `timeout` DURATION operand
 *  (GNU coreutils: NUMBER[SUFFIX], always digit-led). */
function isTimeoutDuration(s: string | null): boolean {
  return s !== null && /^\d/.test(s);
}

/** Convert an array of Words to a space-joined canonical string. */
function wordsToString(words: Word[]): string {
  const parts: string[] = [];
  for (const w of words) {
    const s = wordToString(w);
    if (s !== null) parts.push(s);
  }
  return parts.join(" ");
}

/** Display form of a Word array — joins wordToDisplayString, preserving
 *  the user's original quoting for UI display. */
function wordsToDisplayString(words: Word[]): string {
  const parts: string[] = [];
  for (const w of words) {
    const s = wordToDisplayString(w);
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

  // Peel off `timeout DURATION` (simple form: timeout <duration> cmd)
  if (i < words.length && wordToString(words[i] as Word) === "timeout" &&
      isTimeoutDuration(wordToString(words[i + 1] as Word))) {
    i += 2;
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

  // Peel off `timeout DURATION` (simple form: timeout <duration> cmd)
  if (i < words.length && wordToString(words[i] as Word) === "timeout" &&
      isTimeoutDuration(wordToString(words[i + 1] as Word))) {
    i += 2;
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
  /** Per-subcommand structured token lists.  Parallel to `subcommands`
   *  (same length/order).  Used by token-aware consumers that must not
   *  re-derive intent from the canonical string (e.g. edit-like flag
   *  detection). */
  subcommandWords: Word[][];
  /** Display form — preserves the user's original quoting for UI.  Parallel
   *  to `subcommands` (same length/order). */
  displaySubcommands: string[];
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

/** Mutable accumulator for the three parallel per-subcommand arrays. */
interface SubcommandAccum {
  canonical: string[];
  display: string[];
  words: Word[][];
}

/** Push one subcommand to all three parallel arrays, applying the heredoc
 *  / here-string suffix consistently to the canonical + display strings
 *  (the suffix is the same in both forms — it is our own placeholder, not
 *  a quoted token).  `wordList` may be empty for synthetic subcommands
 *  (find:exec / find:delete / bare echo) that carry no quoting. */
function pushSubcommand(
  acc: SubcommandAccum,
  canonical: string,
  display: string,
  wordList: Word[],
  redirects: Array<{ op: string; target: Word }> | undefined,
  hasHeredoc: boolean,
): void {
  acc.canonical.push(appendRedirectSuffix(canonical, redirects, hasHeredoc));
  acc.display.push(appendRedirectSuffix(display, redirects, hasHeredoc));
  acc.words.push(wordList);
}

/** Deduplicate the three parallel arrays together, keying on the canonical
 *  form (so identical canonical subcommands collapse, keeping their first
 *  display/words).  Returns fresh arrays. */
function dedupParallel(acc: SubcommandAccum): void {
  const seen = new Set<string>();
  const canonical: string[] = [];
  const display: string[] = [];
  const words: Word[][] = [];
  for (let i = 0; i < acc.canonical.length; i++) {
    const key = acc.canonical[i]!;
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(key);
    display.push(acc.display[i]!);
    words.push(acc.words[i]!);
  }
  acc.canonical = canonical;
  acc.display = display;
  acc.words = words;
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
    const acc: SubcommandAccum = { canonical: [], display: [], words: [] };
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
            pushSubcommand(acc, "find:exec", "find:exec", [], cmd.redirects, false);
            return true;
          }
          if (dangerous === "delete") {
            pushSubcommand(acc, "find:delete", "find:delete", [], cmd.redirects, false);
            return false;
          }
        }

        if (isNodeCatastrophic(cmd)) catastrophic = true;

        // Strip wrappers (timeout DURATION, xargs + flags) from the
        // subcommand so permissions are checked against the inner command.
        // Keep sudo prefix since sudo commands should always require approval.
        const words = cmd.words ?? [];
        const effectiveIdx = findEffectiveCommandIdx(words);
        const effective = wordToString(words[effectiveIdx] as Word);

        // `timeout <duration> cmd`: push the wrapper (preapproved via
        // baseline `timeout *`) AND the inner command so the real
        // command is what gets asked about.
        if (effective === "timeout" &&
            isTimeoutDuration(wordToString(words[effectiveIdx + 1] as Word))) {
          const prefixWords = words.slice(0, effectiveIdx); // e.g. [sudo ...]
          const wrapperWords = [...prefixWords, words[effectiveIdx]!, words[effectiveIdx + 1]!];
          pushSubcommand(acc, wordsToString(wrapperWords), wordsToDisplayString(wrapperWords), wrapperWords, cmd.redirects, false);
          const innerWords = words.slice(effectiveIdx + 2);
          if (innerWords.length) {
            const allInner = [...prefixWords, ...innerWords];
            pushSubcommand(acc, wordsToString(allInner), wordsToDisplayString(allInner), allInner, cmd.redirects, false);
          }
        } else if (effective === "xargs") {
          // findEffectiveCommandIdx already skipped any sudo prefix
          const innerStart = skipXargsFlags(words, effectiveIdx + 1);
          const prefixWords = words.slice(0, effectiveIdx); // e.g. [sudo ...]
          const innerWords = words.slice(innerStart);
          const allWords = [...prefixWords, ...innerWords];
          if (allWords.length) {
            pushSubcommand(acc, wordsToString(allWords), wordsToDisplayString(allWords), allWords, cmd.redirects, false);
          } else {
            // xargs with no command defaults to echo
            pushSubcommand(acc, "echo", "echo", [], cmd.redirects, false);
          }
        } else {
          pushSubcommand(acc, commandToString(cmd), commandToDisplayString(cmd), words, cmd.redirects, false);
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
        // Reconstruct the display form of the [[ ... ]] expression from
        // the raw words so quoted operands keep their quotes.
        const displayExpr = `[[ ${wordsToDisplayString(words)} ]]`;
        pushSubcommand(acc, expr, displayExpr, words, undefined, false);
        // Same file-read extraction for [[ TestClause nodes
        const wordStrs = words.map((w) => wordToString(w)).filter((s: string | null): s is string => s !== null);
        for (const p of extractTestFilePaths(wordStrs)) {
          redirects.push({ path: p, direction: "input" });
        }
      });
    }

    dedupParallel(acc);
    return {
      subcommands: acc.canonical,
      subcommandWords: acc.words,
      displaySubcommands: acc.display,
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
      const acc: SubcommandAccum = { canonical: [], display: [], words: [] };
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
              pushSubcommand(acc, "find:exec", "find:exec", [], cmd.redirects, true);
              return true;
            }
            if (dangerous === "delete") {
              pushSubcommand(acc, "find:delete", "find:delete", [], cmd.redirects, true);
              return false;
            }
          }

          if (isNodeCatastrophic(cmd)) catastrophic = true;

          // Strip wrappers (timeout DURATION, xargs + flags) so permissions
          // are checked against the inner command. sudo prefix is kept.
          const words = cmd.words ?? [];
          const effectiveIdx = findEffectiveCommandIdx(words);
          const effective = wordToString(words[effectiveIdx] as Word);

          if (effective === "timeout" &&
              isTimeoutDuration(wordToString(words[effectiveIdx + 1] as Word))) {
            const prefixWords = words.slice(0, effectiveIdx);
            const wrapperWords = [...prefixWords, words[effectiveIdx]!, words[effectiveIdx + 1]!];
            pushSubcommand(acc, wordsToString(wrapperWords), wordsToDisplayString(wrapperWords), wrapperWords, cmd.redirects, true);
            const innerWords = words.slice(effectiveIdx + 2);
            if (innerWords.length) {
              const allInner = [...prefixWords, ...innerWords];
              pushSubcommand(acc, wordsToString(allInner), wordsToDisplayString(allInner), allInner, cmd.redirects, true);
            }
          } else if (effective === "xargs") {
            const innerStart = skipXargsFlags(words, effectiveIdx + 1);
            const prefixWords = words.slice(0, effectiveIdx);
            const innerWords = words.slice(innerStart);
            const allWords = [...prefixWords, ...innerWords];
            if (allWords.length) {
              pushSubcommand(acc, wordsToString(allWords), wordsToDisplayString(allWords), allWords, cmd.redirects, true);
            } else {
              pushSubcommand(acc, "echo", "echo", [], cmd.redirects, true);
            }
          } else {
            pushSubcommand(acc, commandToString(cmd), commandToDisplayString(cmd), words, cmd.redirects, true);
          }

          if (name === "[" || name === "[[") {
            const wordStrs = (cmd.words ?? []).map((w: Word) => wordToString(w)).filter((s: string | null): s is string => s !== null);
            for (const p of extractTestFilePaths(wordStrs)) {
              redirects.push({ path: p, direction: "input" });
            }
          }

          return true;
        }, (expr, words) => {
          const displayExpr = `[[ ${wordsToDisplayString(words)} ]]`;
          pushSubcommand(acc, expr, displayExpr, words, undefined, true);
          const wordStrs = words.map((w) => wordToString(w)).filter((s: string | null): s is string => s !== null);
          for (const p of extractTestFilePaths(wordStrs)) {
            redirects.push({ path: p, direction: "input" });
          }
        });
      }

      dedupParallel(acc);
      return {
        subcommands: acc.canonical,
        subcommandWords: acc.words,
        displaySubcommands: acc.display,
        redirects,
        catastrophic,
        hasHeredoc: true,
      };
    } catch {
      const first = command.trim().split(/\s+/)[0] ?? "";
      return {
        subcommands: first ? [first] : [],
        subcommandWords: [],
        displaySubcommands: first ? [first] : [],
        redirects: [],
        catastrophic: first ? SYSTEM_HALT_COMMANDS.has(first) : false,
        hasHeredoc: true,
      };
    }
  }
}

/** Per-subcommand canonical token lists for a command string. Parallel to
 *  `parseCommand().subcommands` (modulo words that have no canonical form,
 *  which are skipped the same way `commandToString` skips them). This is the
 *  token source for inferred-rule shape analysis — tokens may contain
 *  spaces (quoted words), so consumers must never re-split on whitespace. */
export function subcommandTokenLists(command: string): string[][] {
  const parsed = parseCommand(command);
  return parsed.subcommandWords.map((words) => {
    const toks: string[] = [];
    for (const w of words) {
      const s = wordToString(w);
      if (s !== null) toks.push(s);
    }
    return toks;
  });
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

  // 3–5. Token-aware checks over the structured word lists.  Operating on
  //    tokens (not the joined canonical string) means a quoted literal like
  //    `sed "we are -i today" file` is one token whose literal value is the
  //    whole sentence — it can never be mistaken for the `-i` flag.
  for (const words of parsed.subcommandWords) {
    if (!words.length) continue;
    const base = wordToString(words[0] as Word);
    if (!base) continue;

    // 3. In-place edit flags
    if (base === "sed") {
      for (let i = 1; i < words.length; i++) {
        const t = wordToString(words[i]!);
        if (t === null) continue;
        if (t === "-i" || t.startsWith("-i.") || t === "--in-place") return true;
      }
    }
    if (base === "perl") {
      for (let i = 1; i < words.length; i++) {
        const t = wordToString(words[i]!);
        if (t === null) continue;
        if (tokenHasFlag(t, "-pi") || tokenHasFlag(t, "-pe")) return true;
      }
    }

    // 4. Write-purpose commands
    if (base === "tee" || base === "truncate" || base === "install" || base === "dd") return true;

    // 5. Interpreter one-liner invocations that can embed arbitrary file I/O
    //    python[3] -c, node -e, ruby -e, perl -e, php -r
    if (/^(python3?|node|ruby|perl|php)$/.test(base)) {
      for (let i = 1; i < words.length; i++) {
        const t = wordToString(words[i]!);
        if (t === "-c" || t === "-e" || t === "-r") return true;
      }
    }
    // sh/bash/dash/zsh -c  (subshell execution with code string)
    if (/^(sh|bash|dash|zsh)$/.test(base)) {
      for (let i = 1; i < words.length; i++) {
        const t = wordToString(words[i]!);
        if (t === "-c") return true;
      }
    }
  }

  return false;
}
