import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import { createRequire } from "node:module";
import path from "node:path";

/** Threshold (chars) beyond which a quoted string is considered "opaque"
 *  and collapsed to a placeholder.  Strings at or below this length that
 *  contain no newlines are kept verbatim for readability. */
const OPAQUE_STRING_THRESHOLD = 40;

function isOpaqueString(value: string): boolean {
  return value.includes("\n") || value.length > OPAQUE_STRING_THRESHOLD;
}

/** Resolve backslash escapes in an unquoted word (bash treats `\(`, `\;`,
 *  `\ ` etc. as the literal character).  Single-quoted content is handled
 *  separately and never passes through here. */
function unescapeText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Resolve escapes inside a double-quoted string.  Unlike an unquoted word,
 *  bash only treats backslash as an escape before `$`, backtick, `"`, `\\`,
 *  and newline; before anything else the backslash is literal. */
function unescapeDoubleQuoted(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === "\n") {
        i += 2; // line continuation: both chars vanish
        continue;
      }
      if (next === "$" || next === "`" || next === '"' || next === "\\") {
        out += next;
        i += 2;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser initialization (WASM)
// ---------------------------------------------------------------------------

let parser: Parser | null = null;
let initPromise: Promise<void> | null = null;

function requireFromHere(): NodeRequire {
  return createRequire(import.meta.url);
}

export function isBashParserReady(): boolean {
  return parser !== null;
}

/** One-time async initialization of the tree-sitter WASM parser.
 *  `parseCommand` is synchronous, so this must complete before it is called
 *  (pi awaits an async extension factory before session start; tests await it
 *  in a setup hook). */
export function initBashParser(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const require_ = requireFromHere();
      const runtimeWasm = require_.resolve("web-tree-sitter/web-tree-sitter.wasm");
      await Parser.init({ locateFile: () => runtimeWasm });
      const bashWasm = require_.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
      const language = await Language.load(bashWasm);
      const p = new Parser();
      p.setLanguage(language);
      parser = p;
    })().catch((err) => {
      // Do not latch a rejected init: clear it so a later call (e.g. after
      // `/reload`) can retry instead of being permanently broken.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Word rendering: canonical (de-quoted, placeholders) + display (quotes kept)
// ---------------------------------------------------------------------------

interface Rendered {
  canonical: string;
  display: string;
}

/** Convert a tree-sitter word-ish node into a canonical + display token
 *  (canonical is de-quoted with expansion placeholders; display keeps the
 *  user's original quoting). */
function renderNode(node: Node): Rendered | null {
  switch (node.type) {
    case "word":
    case "number":
    case "test_operator":
    case "variable_name":
    case "string_content":
    case "regex":
    case "brace_expression":
    case "escape_sequence": {
      const text = unescapeText(node.text);
      return { canonical: text, display: text };
    }
    case "raw_string": {
      const inner = node.text.slice(1, -1);
      if (inner === "") return { canonical: "''", display: "''" };
      if (isOpaqueString(inner)) return { canonical: "'...'", display: "'...'" };
      // Display the original source text so the UI shows what was written.
      return { canonical: inner, display: node.text };
    }
    case "string": {
      let hasExpansion = false;
      for (const child of node.namedChildren) {
        if (child.type === "string_content" || child.type === "escape_sequence") continue;
        hasExpansion = true;
      }
      if (hasExpansion) return { canonical: '"..."', display: '"..."' };
      const literal = unescapeDoubleQuoted(node.text.slice(1, -1));
      if (literal === "") return { canonical: '""', display: '""' };
      if (isOpaqueString(literal)) return { canonical: '"..."', display: '"..."' };
      // Display the original source text (including its escapes) so the user
      // approves exactly what will run; re-quoting the unescaped literal would
      // corrupt e.g. `"a\"b"` into `"a"b"`.
      return { canonical: literal, display: node.text };
    }
    case "concatenation": {
      let canonical = "";
      let display = "";
      for (const child of node.namedChildren) {
        const r = renderNode(child);
        if (r) {
          canonical += r.canonical;
          display += r.display;
        }
      }
      return { canonical, display };
    }
    case "simple_expansion":
    case "expansion":
      return { canonical: "${...}", display: "${...}" };
    case "arithmetic_expansion":
      return { canonical: "$((...))", display: "$((...))" };
    case "command_substitution":
      return { canonical: "$(...)", display: "$(...)" };
    case "process_substitution": {
      const placeholder = node.text.startsWith("<") ? "<(...)" : ">(...)";
      return { canonical: placeholder, display: placeholder };
    }
    default: {
      const text = unescapeText(node.text);
      return { canonical: text, display: text };
    }
  }
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

const REDIRECT_TYPES = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
]);

function isRedirectNode(node: Node): boolean {
  return REDIRECT_TYPES.has(node.type);
}

interface RedirectInfo {
  op: string;
  target: string;
  direction: "input" | "output" | null;
}

function redirectOp(node: Node): string {
  const m = node.text.match(/^[0-9]*(<<<|<<-|<<|&>>|&>|>>|>\||<>|>&|<&|>|<)/);
  return m ? m[1]! : "";
}

function parseRedirect(node: Node): RedirectInfo | null {
  if (node.type === "heredoc_redirect") {
    const op = redirectOp(node) === "<<-" ? "<<-" : "<<";
    const start = node.childForFieldName("heredoc_start");
    return { op, target: start?.text ?? "", direction: null };
  }
  if (node.type === "herestring_redirect") {
    return { op: "<<<", target: "", direction: null };
  }
  // file_redirect
  const dest = node.childForFieldName("destination");
  if (!dest) return null;
  const op = redirectOp(node);
  if (op === ">&" || op === "<&") return null;
  let direction: "input" | "output" | null = null;
  if (op === "<") direction = "input";
  else if (op === ">" || op === ">>" || op === "&>" || op === "&>>" || op === ">|" || op === "<>") {
    direction = "output";
  }
  if (dest.type === "number" || dest.type === "file_descriptor") direction = null;
  const target = renderNode(dest)?.canonical ?? dest.text;
  return { op, target, direction };
}

/** Redirects belonging to a `redirected_statement`: its direct redirect
 *  children plus redirects nested one level inside a heredoc (e.g. the `> f`
 *  in `cat <<EOF > f`).  Does not descend into nested commands. */
function collectRedirects(node: Node): RedirectInfo[] {
  const out: RedirectInfo[] = [];
  for (const child of node.namedChildren) {
    if (isRedirectNode(child)) {
      const info = parseRedirect(child);
      if (info) out.push(info);
      if (child.type === "heredoc_redirect") {
        for (const grand of child.namedChildren) {
          if (isRedirectNode(grand)) {
            const gi = parseRedirect(grand);
            if (gi) out.push(gi);
          }
        }
      }
    }
  }
  return out;
}

/** Redirects attached directly to a `command` node (e.g. here-strings). */
function directRedirectChildren(cmd: Node): RedirectInfo[] {
  const out: RedirectInfo[] = [];
  for (const child of cmd.namedChildren) {
    if (isRedirectNode(child)) {
      const info = parseRedirect(child);
      if (info) out.push(info);
    }
  }
  return out;
}

function redirectSuffix(reds: RedirectInfo[]): string {
  let suffix = "";
  for (const r of reds) {
    if (r.op === "<<<") suffix += " <<< '...'";
    else if (r.op === "<<" || r.op === "<<-") suffix += " << '...'";
  }
  return suffix;
}

// ---------------------------------------------------------------------------
// File-test operator extraction (`[ ... ]` / `[[ ... ]]`)
// ---------------------------------------------------------------------------

// File-test operators that take a single path argument (unary).
const UNARY_FILE_TEST_OPS = new Set([
  "-f", "-e", "-d", "-r", "-s", "-L", "-w", "-x", "-h",
  "-O", "-G", "-N", "-k", "-g", "-u",
]);

// Binary operators where both operands are file paths.
const BINARY_FILE_OPS = new Set(["-ef", "-nt", "-ot"]);

// Extract file paths from the token list of a [ or [[ expression.
function extractTestFilePaths(words: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (w === "[[" || w === "]]" || w === "]") continue;
    if (w === "!") continue;
    if (UNARY_FILE_TEST_OPS.has(w)) {
      const next = words[i + 1];
      if (next && next !== "]" && next !== "]]" && !next.startsWith("-")) {
        paths.push(next);
        i++;
      }
    } else if (BINARY_FILE_OPS.has(w)) {
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

/** Flatten a tree-sitter test expression into ordered canonical/display
 *  tokens (operators emitted in source order, parens dropped). */
function flattenTest(node: Node, out: Rendered[]): void {
  switch (node.type) {
    case "unary_expression": {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || !child.isNamed) continue;
        if (node.fieldNameForChild(i) === "operator") {
          out.push({ canonical: child.text, display: child.text });
          continue;
        }
        flattenTest(child, out);
      }
      return;
    }
    case "binary_expression": {
      const left = node.childForFieldName("left");
      const op = node.childForFieldName("operator");
      const right = node.childForFieldName("right");
      if (left) flattenTest(left, out);
      if (op) out.push({ canonical: op.text, display: op.text });
      if (right) flattenTest(right, out);
      return;
    }
    case "parenthesized_expression": {
      for (const child of node.namedChildren) flattenTest(child, out);
      return;
    }
    default: {
      const r = renderNode(node);
      if (r) out.push(r);
    }
  }
}

// ---------------------------------------------------------------------------
// Command wrapper peeling (sudo / timeout / xargs)
// ---------------------------------------------------------------------------

const SUDO_FLAGS_WITH_ARGS = new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "-T", "-R"]);

const XARGS_FLAGS_WITH_ARGS = new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s"]);

// Long xargs options that consume a separate following argument.
const XARGS_LONG_FLAGS_WITH_ARGS = new Set([
  "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars",
  "--max-lines", "--max-procs", "--process-slot-var",
]);

/** Starting at `start`, skip past xargs options and return the index of the
 *  first non-option token (the inner command). */
function skipXargsFlags(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") { i++; break; }
    if (w.startsWith("--")) {
      if (XARGS_LONG_FLAGS_WITH_ARGS.has(w)) { i += 2; continue; }
      i++;
      continue;
    }
    if (w.startsWith("-")) {
      if (XARGS_FLAGS_WITH_ARGS.has(w)) { i += 2; continue; }
      i++;
      continue;
    }
    break;
  }
  return i;
}

/** Walks past a sudo prefix and returns the index of the effective command. */
function findEffectiveCommandIdx(words: string[]): number {
  if (words[0] !== "sudo") return 0;
  let skipNext = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (skipNext) { skipNext = false; continue; }
    if (w.startsWith("-")) {
      if (SUDO_FLAGS_WITH_ARGS.has(w)) skipNext = true;
      continue;
    }
    return i;
  }
  return words.length;
}

function isAssignmentToken(w: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
}

function skipSimpleFlags(words: string[], start: number): number {
  let i = start;
  if (words[i] === "--") return i + 1;
  while (i < words.length && words[i]!.startsWith("-")) i++;
  return i;
}

function skipEnv(words: string[], start: number): number {
  let i = start;
  while (i < words.length) {
    const w = words[i]!;
    if (w === "--") { i++; break; }
    if (w === "-i" || w === "--ignore-environment") { i++; continue; }
    if (w === "-u" || w === "--unset") { i += 2; continue; }
    if (w.startsWith("--unset=")) { i++; continue; }
    if (w.startsWith("-") && w !== "-") { i++; continue; }
    if (isAssignmentToken(w)) { i++; continue; }
    break;
  }
  return i;
}

function skipNice(words: string[], start: number): number {
  if (words[start] === "-n") return start + 2;
  if (words[start] && /^-\d+$/.test(words[start]!)) return start + 1;
  return start;
}

function skipIonice(words: string[], start: number): number {
  let i = start;
  while (i < words.length && words[i]!.startsWith("-")) {
    const w = words[i]!;
    if (w === "-c" || w === "-n" || w === "-p") { i += 2; continue; }
    i++;
  }
  return i;
}

/** Peel wrapper programs (`env`, `nice`, `nohup`, `command`, `setsid`,
 *  `stdbuf`, `ionice`) that stand between the shell and the real command. */
function skipWrappers(words: string[], start: number): number {
  let i = start;
  for (;;) {
    const w = words[i];
    if (w === "env") { i = skipEnv(words, i + 1); continue; }
    if (w === "nice") { i = skipNice(words, i + 1); continue; }
    if (w === "nohup" || w === "setsid" || w === "command" || w === "builtin") {
      i = skipSimpleFlags(words, i + 1);
      continue;
    }
    if (w === "stdbuf") {
      i++;
      while (words[i]?.startsWith("-")) i++;
      continue;
    }
    if (w === "ionice") { i = skipIonice(words, i + 1); continue; }
    return i;
  }
}

/** Index of the effective command after peeling sudo, wrappers, timeout and
 *  xargs (in any order). */
function effectiveCommandIndex(words: string[]): number {
  let i = findEffectiveCommandIdx(words);
  for (;;) {
    const before = i;
    i = skipWrappers(words, i);
    if (i < words.length && words[i] === "timeout" && isTimeoutDuration(words[i + 1])) {
      i += 2;
    } else if (i < words.length && words[i] === "xargs") {
      i = skipXargsFlags(words, i + 1);
    }
    if (i === before) break;
  }
  return i;
}

/** True iff `s` looks like a `timeout` DURATION operand
 *  (GNU coreutils: NUMBER[SUFFIX], always digit-led). */
function isTimeoutDuration(s: string | undefined): boolean {
  return typeof s === "string" && /^\d/.test(s);
}

/** Test whether a single token acts as `flag`.  A token matches if it equals
 *  the flag, or is the flag followed by a non-word suffix (so `-i.bak`
 *  matches `-i`, but `-in` does not). */
function tokenHasFlag(token: string, flag: string): boolean {
  if (token === flag) return true;
  if (!token.startsWith(flag)) return false;
  const next = token[flag.length];
  return next !== undefined && !/[A-Za-z0-9_]/.test(next);
}

/** True if a sed option token enables in-place editing.  Handles `-i`,
 *  `-iSUFFIX`, short clusters (`-ni`, `-Ei`), and `--in-place[=SUFFIX]`.
 *  `-e`/`-f` consume the rest of the token as their argument. */
function sedHasInPlace(token: string): boolean {
  if (token === "--in-place" || token.startsWith("--in-place=")) return true;
  if (!token.startsWith("-") || token.startsWith("--") || token === "-") return false;
  for (let i = 1; i < token.length; i++) {
    const c = token[i]!;
    if (c === "i") return true;
    if (c === "e" || c === "f") return false;
  }
  return false;
}

/** True if a perl option token enables in-place editing (`-i`, `-pi`,
 *  `-pie`, `-i.bak`).  `-e`/`-E`/`-I`/`-F`/`-M`/`-m`/`-d` consume the rest
 *  of the token as an argument. */
function perlHasInPlace(token: string): boolean {
  if (!token.startsWith("-") || token.startsWith("--") || token === "-") return false;
  for (let i = 1; i < token.length; i++) {
    const c = token[i]!;
    if (c === "i") return true;
    if ("eEFIMmd".includes(c)) return false;
  }
  return false;
}

/** True when a dangerous verb (rm/chmod/chown) targets an operand we cannot
 *  resolve statically — an expansion (`$…`, `$(…)`) or a quoted expansion
 *  collapsed to `"..."`.  These must not be silently auto-approved. */
function hasUnresolvedOperand(tokens: string[]): boolean {
  const base = getBaseWord(tokens);
  if (base !== "rm" && base !== "chmod" && base !== "chown") return false;
  return getNonFlagArgs(tokens).some((a) => a.startsWith("$") || a === '"..."');
}

const SYSTEM_HALT_COMMANDS = new Set(["shutdown", "reboot", "halt", "poweroff", "init"]);

const PROTECTED_DIRS = new Set(
  "/ /usr /usr/local /usr/bin /usr/lib /usr/sbin /usr/share /etc /var /bin /sbin /lib /lib64 /boot /sys /proc /dev /root /opt /home /srv /snap /tmp".split(" "),
);

/** True when `arg` refers to a protected system dir, accounting for trailing
 *  slashes, redundant separators, `..` traversal, and glob suffixes that still
 *  resolve under a protected dir (e.g. `/usr/*`, `/var/**`). */
function isProtectedPath(arg: string): boolean {
  if (!arg.startsWith("/")) return false;
  const literal = arg.split(/[*?\[]/)[0] ?? arg;
  const normalized = path.posix.normalize(literal).replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return true;
  return PROTECTED_DIRS.has(normalized);
}

/** Device files that are always safe to use as redirect targets. */
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

function getBaseWord(words: string[]): string | null {
  const i = effectiveCommandIndex(words);
  if (i >= words.length) return null;
  return words[i] ?? null;
}

function getNonFlagArgs(words: string[]): string[] {
  const i = effectiveCommandIndex(words);
  const args: string[] = [];
  for (let j = i + 1; j < words.length; j++) {
    const s = words[j]!;
    if (!s.startsWith("-")) args.push(s);
  }
  return args;
}

function isCatastrophic(tokens: string[]): boolean {
  const baseCmd = getBaseWord(tokens);
  if (!baseCmd) return false;

  if (SYSTEM_HALT_COMMANDS.has(baseCmd)) return true;
  if (/^mkfs\.?/.test(baseCmd)) return true;

  const cmdStr = tokens.join(" ");
  if (baseCmd === "dd" && /of=\/dev\//.test(cmdStr)) return true;
  if (baseCmd === "rm" && /--no-preserve-root/.test(cmdStr)) return true;

  if (baseCmd === "rm" || baseCmd === "chmod" || baseCmd === "chown") {
    const args = getNonFlagArgs(tokens);
    if (args.some((a) => a === "~" || a.startsWith("$") || isProtectedPath(a))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// token extraction for a `command` node
// ---------------------------------------------------------------------------

function commandTokens(cmd: Node): { tokens: string[]; displays: string[] } {
  const tokens: string[] = [];
  const displays: string[] = [];
  for (let i = 0; i < cmd.childCount; i++) {
    const child = cmd.child(i);
    if (!child || !child.isNamed) continue;
    if (isRedirectNode(child)) continue;
    if (child.type === "comment") continue;
    // Variable assignments prefixed to a command (`VAR=x cmd`) are not part
    // of the command's word list — the effective command name comes first.
    if (child.type === "variable_assignment") continue;
    const target = child.type === "command_name"
      ? (child.namedChildren[0] ?? child)
      : child;
    const r = renderNode(target);
    if (r) {
      tokens.push(r.canonical);
      displays.push(r.display);
    }
  }
  return { tokens, displays };
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

interface Acc {
  canonical: string[];
  display: string[];
  words: string[][];
  redirects: RedirectTarget[];
  catastrophic: boolean;
  forceAsk: boolean;
}

function addSub(acc: Acc, tokens: string[], displays: string[], suffix = ""): void {
  acc.canonical.push(tokens.join(" ") + suffix);
  acc.display.push(displays.join(" ") + suffix);
  acc.words.push(tokens);
}

function findDangerous(tokens: string[]): "exec" | "delete" | null {
  const args = tokens.slice(1);
  if (args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) return "exec";
  if (args.some((a) => a === "-delete")) return "delete";
  return null;
}

function emitCommand(cmd: Node, reds: RedirectInfo[], acc: Acc): void {
  const { tokens, displays } = commandTokens(cmd);
  if (!tokens.length) return;
  const suffix = redirectSuffix(reds);
  const name = tokens[0]!;

  if (name === "find") {
    const dangerous = findDangerous(tokens);
    if (dangerous === "exec") {
      addSub(acc, ["find:exec"], ["find:exec"], suffix);
      return;
    }
    if (dangerous === "delete") {
      addSub(acc, ["find:delete"], ["find:delete"], suffix);
      return;
    }
  }

  if (isCatastrophic(tokens)) acc.catastrophic = true;
  if (hasUnresolvedOperand(tokens)) acc.forceAsk = true;

  for (const r of reds) {
    if (r.direction) acc.redirects.push({ path: r.target, direction: r.direction });
  }

  const effectiveIdx = findEffectiveCommandIdx(tokens);
  const effective = tokens[effectiveIdx];

  if (effective === "timeout" && isTimeoutDuration(tokens[effectiveIdx + 1])) {
    const prefixT = tokens.slice(0, effectiveIdx);
    const prefixD = displays.slice(0, effectiveIdx);
    const wrapperT = [...prefixT, tokens[effectiveIdx]!, tokens[effectiveIdx + 1]!];
    const wrapperD = [...prefixD, displays[effectiveIdx]!, displays[effectiveIdx + 1]!];
    addSub(acc, wrapperT, wrapperD, suffix);
    const innerT = tokens.slice(effectiveIdx + 2);
    const innerD = displays.slice(effectiveIdx + 2);
    if (innerT.length) {
      addSub(acc, [...prefixT, ...innerT], [...prefixD, ...innerD], suffix);
    }
    return;
  }

  if (effective === "xargs") {
    const innerStart = skipXargsFlags(tokens, effectiveIdx + 1);
    const prefixT = tokens.slice(0, effectiveIdx);
    const prefixD = displays.slice(0, effectiveIdx);
    const innerT = tokens.slice(innerStart);
    const innerD = displays.slice(innerStart);
    const allT = [...prefixT, ...innerT];
    const allD = [...prefixD, ...innerD];
    if (allT.length) addSub(acc, allT, allD, suffix);
    else addSub(acc, ["echo"], ["echo"], suffix);
    return;
  }

  addSub(acc, tokens, displays, suffix);
}

function emitTest(cmd: Node, acc: Acc): void {
  const rendered: Rendered[] = [];
  for (const child of cmd.namedChildren) flattenTest(child, rendered);
  const open = cmd.text.startsWith("[[") ? "[[" : "[";
  const close = open === "[[" ? "]]" : "]";
  const tokens = rendered.map((r) => r.canonical);
  const displays = rendered.map((r) => r.display);
  addSub(acc, [open, ...tokens, close], [open, ...displays, close]);
  for (const p of extractTestFilePaths(tokens)) {
    acc.redirects.push({ path: p, direction: "input" });
  }
}

function recurseChildren(node: Node, acc: Acc): void {
  for (const child of node.namedChildren) walk(child, acc);
}

function walk(node: Node, acc: Acc): void {
  if (node.type === "redirected_statement") {
    const body = node.childForFieldName("body");
    const reds = collectRedirects(node);
    if (body) {
      if (body.type === "command") {
        emitCommand(body, [...reds, ...directRedirectChildren(body)], acc);
        recurseChildren(body, acc);
      } else {
        for (const r of reds) {
          if (r.direction) acc.redirects.push({ path: r.target, direction: r.direction });
        }
        walk(body, acc);
      }
    }
    for (const child of node.namedChildren) {
      if (body && child.id === body.id) continue;
      walk(child, acc);
    }
    return;
  }

  if (node.type === "command") {
    emitCommand(node, directRedirectChildren(node), acc);
    recurseChildren(node, acc);
    return;
  }

  if (node.type === "test_command") {
    emitTest(node, acc);
    recurseChildren(node, acc);
    return;
  }

  // Some nodes carry redirect children directly without a wrapping
  // `redirected_statement` (e.g. function definitions: `f() { ...; } > out`).
  // Surface their file targets; they belong to no single subcommand.
  if (!isRedirectNode(node)) {
    for (const child of node.namedChildren) {
      if (isRedirectNode(child)) {
        const info = parseRedirect(child);
        if (info?.direction) acc.redirects.push({ path: info.target, direction: info.direction });
      }
    }
  }

  recurseChildren(node, acc);
}

function dedup(acc: Acc): void {
  const seen = new Set<string>();
  const canonical: string[] = [];
  const display: string[] = [];
  const words: string[][] = [];
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedirectTarget {
  path: string;
  direction: "input" | "output";
}

export interface ParsedCommand {
  subcommands: string[];
  /** Per-subcommand canonical token lists, parallel to `subcommands`
   *  (same length/order).  Used by token-aware consumers that must not
   *  re-derive intent from the canonical string (e.g. edit-like flag
   *  detection). */
  subcommandWords: string[][];
  /** Display form — preserves the user's original quoting for UI.  Parallel
   *  to `subcommands` (same length/order). */
  displaySubcommands: string[];
  redirects: RedirectTarget[];
  catastrophic: boolean;
  /** True when a dangerous verb targets an operand that cannot be resolved
   *  statically (e.g. `rm -rf "$DIR"`).  Callers must not silently allow it. */
  forceAsk: boolean;
  /** True when the parser could not produce a trustworthy result (null tree
   *  or an unexpected internal failure).  Callers must fail CLOSED on this
   *  rather than treating the empty/partial result as an allow. */
  parseFailed: boolean;
}

/** Fail-closed result for a command the parser could not handle. */
function failedResult(command: string): ParsedCommand {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return {
    subcommands: first ? [first] : [],
    subcommandWords: first ? [[first]] : [],
    displaySubcommands: first ? [first] : [],
    redirects: [],
    catastrophic: first ? SYSTEM_HALT_COMMANDS.has(first) : false,
    forceAsk: false,
    parseFailed: true,
  };
}

export function parseCommand(command: string): ParsedCommand {
  if (!parser) {
    throw new Error("bash parser not initialized; call initBashParser() first");
  }
  const acc: Acc = { canonical: [], display: [], words: [], redirects: [], catastrophic: false, forceAsk: false };
  try {
    const tree = parser.parse(command);
    if (!tree) return failedResult(command);
    try {
      walk(tree.rootNode, acc);
    } finally {
      tree.delete();
    }
  } catch {
    // tree-sitter is error-tolerant, so this is unexpected; fail closed rather
    // than silently substituting a first-token guess that could allow execution.
    return failedResult(command);
  }

  dedup(acc);
  return {
    subcommands: acc.canonical,
    subcommandWords: acc.words,
    displaySubcommands: acc.display,
    redirects: acc.redirects,
    catastrophic: acc.catastrophic,
    forceAsk: acc.forceAsk,
    parseFailed: false,
  };
}

/** Per-subcommand canonical token lists for a command string. Parallel to
 *  `parseCommand().subcommands`. This is the token source for inferred-rule
 *  shape analysis — tokens may contain spaces (quoted words), so consumers
 *  must never re-split on whitespace. */
export function subcommandTokenLists(command: string): string[][] {
  return parseCommand(command).subcommandWords;
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
  // 1. Any output redirect detected by the parser
  //    (excluding redirects to safe device files like /dev/null)
  if (parsed.redirects.some((r) => r.direction === "output" && !SAFE_DEVICE_FILES.has(r.path))) return true;

  // 2. Heredoc / here-string content is collapsed to a `<< '...'` subcommand
  //    suffix by parseCommand(); no separate scan needed here.

  // 3–5. Token-aware checks over the structured word lists.  Operating on
  //    tokens (not the joined canonical string) means a quoted literal like
  //    `sed "we are -i today" file` is one token whose literal value is the
  //    whole sentence — it can never be mistaken for the `-i` flag.
  for (const tokens of parsed.subcommandWords) {
    if (!tokens.length) continue;
    const base = tokens[0];
    if (!base) continue;

    // 3. In-place edit flags
    if (base === "sed") {
      for (let i = 1; i < tokens.length; i++) {
        if (sedHasInPlace(tokens[i]!)) return true;
      }
    }
    if (base === "perl") {
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (perlHasInPlace(t) || tokenHasFlag(t, "-pe")) return true;
      }
    }

    // 4. Write-purpose commands
    if (base === "tee" || base === "truncate" || base === "install" || base === "dd") return true;

    // 5. Interpreter one-liner invocations that can embed arbitrary file I/O
    if (/^(python3?|node|ruby|perl|php)$/.test(base)) {
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!;
        if (t === "-c" || t === "-e" || t === "-r") return true;
      }
    }
    // sh/bash/dash/zsh -c  (subshell execution with code string)
    if (/^(sh|bash|dash|zsh)$/.test(base)) {
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === "-c") return true;
      }
    }
  }

  return false;
}
