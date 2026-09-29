/**
 * expansion.ts — static resolution of shell variable references in bash words.
 *
 * Bash operands built from variables (`cat $F`) reach the permission check as
 * an unresolvable name, which is not a path and not a hidden secret — so the
 * check would silently allow reading a secured file. We resolve the ones we
 * can pin down exactly:
 *
 *  - variables assigned earlier in the same command (`F=.env; cat $F`),
 *  - exported environment variables (pi runs `bash -c <cmd>` per tool call with
 *    `{...process.env}`, so `process.env` IS the shell's environment),
 *  - `PWD` (the session cwd).
 *
 * Anything else — command substitution, arithmetic, `${x#pat}`-style
 * manipulations, shell-special params ($?, $$, $*) — resolves to `undefined`
 * and callers must treat that as "unknown, escalate". Never guess a value: a
 * wrong guess here is a fail-open.
 */

/** Known variables; a `undefined` value means "set, but not statically known". */
export type VarMap = Map<string, string | undefined>;

/** Preloaded variable state for a command: `PWD` is known; unknown env is not. */
export function newVarMap(cwd: string): VarMap {
  const vars: VarMap = new Map();
  vars.set("PWD", cwd);
  return vars;
}

interface Advanced {
  value: string;
  next: number;
}

function lookupVar(name: string, vars: VarMap, cwd: string): string | undefined {
  if (vars.has(name)) return vars.get(name);
  if (name === "HOME") return process.env.HOME ?? process.env.USERPROFILE;
  if (name === "PWD") return cwd;
  if (name === "OLDPWD") return undefined; // shell-local, unknown here
  return process.env[name];
}

function expandAt(word: string, i: number, vars: VarMap, cwd: string): Advanced | undefined {
  const next = word[i + 1];
  if (next !== "{") {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word.slice(i + 1));
    // $<digit>, $?, $$, $@, $* etc. are shell state we cannot know statically.
    if (!name) return undefined;
    const value = lookupVar(name[0]!, vars, cwd);
    return value === undefined ? undefined : { value, next: i + 1 + name[0]!.length };
  }
  // ${NAME...}
  let end = i + 2;
  let depth = 1;
  while (end < word.length && depth > 0) {
    if (word[end] === "{") depth++;
    else if (word[end] === "}") depth--;
    if (depth > 0) end++;
    else break;
  }
  if (depth !== 0) return undefined;
  const inner = word.slice(i + 2, end);
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(:-|-|:=|=|\?|:\?)?([\s\S]*)$/.exec(inner);
  if (!m) return undefined;
  const name = m[1]!;
  const op = m[2];
  const def = m[3] ?? "";
  const value = lookupVar(name, vars, cwd);
  if (op === undefined) return value === undefined ? undefined : { value, next: end + 1 };
  // Only ${x:-d}, ${x-d}, ${x:=d}, ${x=d} are representable; the error forms
  // (${x:?d}/${x?d}) touch shell state we don't model.
  if (op === "?") return undefined;
  const knownOrEmpty = value !== undefined;
  const wantDefault = (op === ":-" || op === ":=") ? value === undefined || value === "" : value === undefined;
  if (!wantDefault) return knownOrEmpty ? { value: value!, next: end + 1 } : undefined;
  const d = resolveTextWord(def, vars, cwd);
  return d === undefined ? undefined : { value: d, next: end + 1 };
}

/** Resolve bare text (no quotes) containing expansions. */
function resolveTextWord(text: string, vars: VarMap, cwd: string): string | undefined {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "`") return undefined; // command substitution
    if (ch === "$") {
      const r = expandAt(text, i, vars, cwd);
      if (r === undefined) return undefined;
      out += r.value;
      i = r.next;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Resolve one display word (original quoting preserved, expansions written as
 * `$F` / `${F:-x}`). `undefined` means the value cannot be pinned down
 * statically and the caller must escalate rather than assume.
 */
export function resolveDisplayWord(word: string, vars: VarMap, cwd: string): string | undefined {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const ch = word[i]!;
    if (ch === "'") {
      // Single quotes: literal, no expansion.
      const end = word.indexOf("'", i + 1);
      if (end === -1) return undefined; // unbalanced source — don't guess
      out += word.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      // Double quotes: literals plus expansions.
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        if (word[j] === "\\") {
          out += word[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (word[j] === "`") return undefined;
        if (word[j] === "$") {
          const r = expandAt(word, j, vars, cwd);
          if (r === undefined) return undefined;
          out += r.value;
          j = r.next;
          continue;
        }
        out += word[j];
        j++;
      }
      if (j >= word.length) return undefined; // unbalanced
      i = j + 1;
      continue;
    }
    if (ch === "\\") {
      out += word[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (ch === "`") return undefined;
    if (ch === "$") {
      const r = expandAt(word, i, vars, cwd);
      if (r === undefined) return undefined;
      out += r.value;
      i = r.next;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Apply a `NAME=VALUE` word to the map (`VALUE` resolved against the current
 * map). Returns true when the word looked like an assignment at all.
 */
export function recordAssignment(word: string, vars: VarMap, cwd: string): boolean {
  const eq = word.indexOf("=");
  if (eq < 1) return false;
  const name = word.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  vars.set(name, resolveDisplayWord(word.slice(eq + 1), vars, cwd));
  return true;
}