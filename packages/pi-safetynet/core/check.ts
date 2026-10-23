import type { ProfileName, PermissionAction, Rule, Ruleset, ModeAliases } from "./types.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { getBaselineRules } from "./permissions/index.ts";
import { parseCommand, subcommandTokenLists, isHazardousFile, isEditLikeBashCommand } from "./bash-parser.ts";
import { normalizePathForMatching, expandHome, isExternalPath } from "pi-submarine-core";
import { newVarMap, resolveDisplayWord, recordAssignment } from "./expansion.ts";
import type { VarMap } from "./expansion.ts";
import { getSandboxDir, isWithinSandbox, isWithinScratchBase, resolveAbsolute } from "./sandbox.ts";
import { patternMatches } from "./inferred/shapes.ts";
import type { InferredBashRule } from "./inferred/store.ts";
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

export interface PermissionCheck {
  action: PermissionAction;
  reason?: string;
  unapproved?: string[];
  /** Display form of each unapproved subcommand — preserves the user's
   *  original quoting for UI display.  Parallel to `unapproved` (same
   *  length/order). */
  unapprovedDisplay?: string[];
  redirectTargets?: Array<{ permission: "read" | "edit"; path: string }>;
  /** True when the deny is caused by a hazardous/sensitive file (e.g. .env,
   *  .ssh, credentials).  Hazardous denials nudge-and-continue up to a per-scope
   *  cap instead of aborting the turn immediately. */
  hazardous?: boolean;
  /** True when the deny is enforced by the active mode (e.g. a bash write in
   *  read-only mode). Lets the deny path label the nudge "Mode denied" and
   *  attach mode-specific recovery guidance. */
  modeDenied?: boolean;
  /** True for denials no user override may bypass: catastrophic commands and
   *  unparseable input (fail-closed). */
  unforceable?: boolean;
  /** Corrective hint instead of a user prompt: the action is safe but aimed at
   *  the wrong place (e.g. another session's scratch dir). The pipeline sends
   *  it to the model as a hidden nudge and does not prompt or review. Only set
   *  when every ask in the command is a scope miss. */
  narrow?: string;
  /** Subcommands awaiting approval that contain an opaque (collapsed) literal.
   *  A durable rule minted from one would match any other long argument in the
   *  same position, so callers must approve these for this invocation only. */
  opaquePayload?: string[];
}

/** True when the checked action has write side effects: an edit/write tool
 *  call, or a bash command writing through an output redirect. Mechanical
 *  classification — commands whose writing is only detectable semantically
 *  (git commit, touch, mkdir) are NOT flagged here; the reviewer prompt's
 *  Session-mode rule denies those in read-only sessions. */
export function actionWrites(permission: "bash" | "read" | "edit", check: PermissionCheck): boolean {
  if (permission === "edit") return true;
  if (permission === "bash") {
    return (check.redirectTargets ?? []).some((rt) => rt.permission === "edit");
  }
  return false;
}

/** True when a bash pattern contains glob/regex metacharacters the matcher
 *  broadens (`*` → `.*`; `?` acts as a regex quantifier). A rule minted from an
 *  approved command that contains one would authorize a *family* of commands
 *  (`rm -rf *` → `rm -rf .*`), not the single command the user/reviewer
 *  approved, so those approvals must stay invocation-only. */
export function patternHasBashGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/**
 * True when a subcommand must stay invocation-only: persisting it as a durable
 * rule would authorize a FAMILY of commands rather than the one approved.
 *
 *  Two shapes do that. A shell glob is widened by the matcher (`rm -rf *` →
 *  `rm -rf .*`). An OPAQUE PAYLOAD — a quoted string too long or too multi-line
 *  to inline, which the parser collapses to `'...'` — is the sharper hazard:
 *  the placeholder is identical for every long argument, so approving
 *  `ssh host '<a 200-char script>'` once would silently authorize any other
 *  script on that host. (Measured: a durable rule minted from a long ssh
 *  payload allowed a destructive payload to the same host and did NOT match a
 *  short, benign one.)
 *
 *  The parser reports the second case structurally (`opaqueSubcommands`), not
 *  by string inspection: `"..."` is ALSO how a quoted expansion renders
 *  (`rm -rf "$DIR"`), and those approvals must keep working. */

export function checkFileTarget(
  filePath: string,
  permission: "read" | "edit",
  profile: ProfileName,
  rules: Ruleset,
  cwd?: string,
  trustExternalPaths = false,
  modeAliases: ModeAliases = {},
): PermissionCheck {
  if (isHazardousFile(filePath)) {
    return { action: "deny", reason: "Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.", hazardous: true };
  }

  if (SAFE_DEVICE_FILES.has(filePath)) {
    return { action: "allow" };
  }

  const absCwd = cwd ?? process.cwd();

  // The session sandbox is a trusted scratch subtree: reads and writes there
  // are allowed in every mode. Placed after the hazardous check so sensitive
  // names stay blocked everywhere.
  if (isWithinSandbox(filePath, absCwd)) {
    return { action: "allow" };
  }

  const normalized = normalizePathForMatching(filePath, absCwd);

  const result = evaluatePermission(permission, normalized, profile, rules, undefined, modeAliases);
  if (result.action === "deny") {
    return {
      action: "deny",
      reason: result.matchedRule?.reason ?? "Automatically denied",
    };
  }

  // For external paths, the baseline catch-all rules (e.g. read: ** -> allow)
  // match but should not automatically approve — the user should be asked.
  // However, if an explicit rule matched (e.g. a user-added allow rule for a
  // specific external path, or a user-added ** rule), honour it.
  //
  // External paths are identified by the normalized form: internal paths
  // are "." or relative (e.g. "src/foo.ts"), while external paths remain
  // absolute (e.g. "/etc/passwd") after normalization.
  if (!trustExternalPaths && normalized.startsWith("/")) {
    if (result.action === "allow" && result.matchedRule?.pattern === "**") {
      // Only downgrade when the matched rule came from the baseline —
      // user-added ** rules should be honoured as explicit approvals.
      const baseline = getBaselineRules();
      if (baseline.includes(result.matchedRule)) {
        return { action: "ask", reason: "Path is outside project root" };
      }
    }
  }

  return { action: result.action };
}

/** True when a rule's pattern is exact-shape — it names the one subcommand
 *  shape that was approved, not a family of commands (no `*`/`?` globs). */
function isExactShapeRule(rule: Rule): boolean {
  return !/[*?]/.test(rule.pattern);
}

/** True when an allow verdict came from a rule the user (or the reviewer's
 *  minted approval rules) explicitly approved rather than a baseline
 *  catch-all. Explicit rules override the operand escalations below — one
 *  those escalations, an approval could never stick and every recheck would
 *  re-ask forever. Shared by the unresolved-operand and external-path
 *  downgrades. */
function isExplicitRule(matchedRule: Rule | undefined): boolean {
  return (
    matchedRule !== undefined &&
    (isExactShapeRule(matchedRule) || !getBaselineRules().includes(matchedRule))
  );
}

/** Check whether a subcommand consists entirely of variable assignments
 *  (e.g. `A=1`, `ORDER_ID=abc`).  Such commands are always safe — they
 *  only set env vars in the current shell context and don't execute any
 *  external command.  Command substitutions within the value (e.g.
 *  `A=$(cmd)`) are extracted as separate subcommands by the parser and
 *  checked independently.
 *
 *  Classification uses the parser's canonical token list, NOT a whitespace
 *  split of the raw subcommand.  An assignment value may legitimately contain
 *  spaces (`A=$(cmd arg)`, `A="a b"`), and the parser already keeps each
 *  value as one token; re-splitting the raw text made those wrappers look
 *  like unknown commands and forced an approval. */
function isBareAssignment(tokens: string[]): boolean {
  return tokens.length > 0
    && tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

/** Parsed `cd` target. `unknown` covers `cd -` (OLDPWD is not statically
 *  knowable). Returns null when the subcommand is not a `cd`. */
type CdTarget = { kind: "path"; target: string } | { kind: "unknown" };

function cdTargetOf(subcommand: string): CdTarget | null {
  const trimmed = subcommand.trim();
  if (trimmed === "cd") return { kind: "path", target: "~" };

  const cdMatch = trimmed.match(/^cd\s+(.+)$/);
  if (!cdMatch) return null;

  let target = cdMatch[1]!.trim();
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  target = expandHome(target);
  if (target === "-") return { kind: "unknown" };
  if (!target) return null;
  return { kind: "path", target };
}

/** Does an inferred rule apply to this profile? Mirrors the alias-aware
 *  matching of explicit rules. */
function inferredRuleApplies(
  rule: InferredBashRule,
  profile: ProfileName,
  modeAliases: ModeAliases,
): boolean {
  if (rule.modes.includes(profile)) return true;
  for (const [from, to] of Object.entries(modeAliases)) {
    if (to === profile && rule.modes.includes(from as ProfileName)) return true;
  }
  return false;
}

/**
 * Verbs whose operands are file paths — the only ones whose arguments can name
 * a secured file or escape the project root. Everything else (`echo`, `git`,
 * `printf`, …) carries text, and its arguments are never scanned, so passing a
 * hazardous name as message/pattern text is not a false positive.
 */
const FILE_VERBS = new Set([
  "cat", "head", "tail", "tac", "less", "more", "nl", "column",
  "grep", "rg", "sed", "awk", "mawk", "gawk",
  "cp", "mv", "rm", "ln", "link", "install", "tee", "dd", "truncate", "shred",
  "chmod", "chown",
  "scp", "rsync", "tar", "zip", "unzip", "gzip", "gunzip", "bzip2", "xz",
  "sort", "cut", "wc", "paste", "join", "comm", "diff", "diff3", "patch",
  "strings", "xxd", "od", "hexdump", "file", "stat", "split", "iconv",
  "base64", "md5sum", "sha1sum", "sha256sum", "realpath", "readlink",
  "basename", "dirname", "du", "find", "xargs",
]);

/** First word of a subcommand that names a file-touching verb, else null. */
function firstFileVerb(tokens: string[]): string | null {
  for (const t of tokens) if (FILE_VERBS.has(t)) return t;
  return null;
}

/** Flags whose VALUE is pattern/script text rather than a path, by verb. */
const TEXT_VALUE_FLAGS: Record<string, string[]> = {
  grep: ["-e", "-E", "-P", "--regexp", "--include", "--exclude", "--exclude-dir"],
  rg: ["-e", "-E", "-F", "-P", "--regexp", "--glob", "--iglob", "--sort"],
  sed: ["-e", "--expression"],
  find: ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"],
};

/** Verbs whose first non-flag operand is text (pattern/program), not a path. */
const TEXT_FIRST_OPERAND = new Set(["grep", "rg", "sed", "awk", "mawk", "gawk", "jq", "yq"]);

/** Word indexes of a subcommand that carry text (pattern/script), not paths. */
function textOperandIndexes(verb: string, tokens: string[]): Set<number> {
  const text = new Set<number>();
  const flags = TEXT_VALUE_FLAGS[verb] ?? [];
  let textFromFlag = false;
  let fileFromFlag = false;
  for (let i = 1; i < tokens.length; i++) {
    const w = tokens[i]!;
    if (w === "-f" || w === "--file") fileFromFlag = true; // pattern/program file: a real read
    if (flags.includes(w)) {
      if (i + 1 < tokens.length) text.add(i + 1);
      textFromFlag = true;
      continue;
    }
    const eq = w.indexOf("=");
    if (eq > 1 && flags.includes(w.slice(0, eq))) {
      text.add(i);
      textFromFlag = true;
    }
  }
  if (TEXT_FIRST_OPERAND.has(verb) && !textFromFlag && !fileFromFlag) {
    for (let i = 1; i < tokens.length; i++) {
      if (!tokens[i]!.startsWith("-")) {
        text.add(i);
        break;
      }
    }
  }
  return text;
}

/** Shared hazardous-file message for bash operands, file tools, and redirects. */
const HAZARDOUS_REASON =
  "Sensitive file (e.g., .env, .ssh, credentials): contains secrets, access blocked. Don't read or write it. If you need a secret value, ask the user or use an already-set environment variable instead.";

/** Strip a single layer of matching quotes. */
function unquote(token: string): string {
  return token.replace(/^['"]+|['"]+$/g, "").trim();
}

/**
 * Find a token naming a hazardous file, tolerating the shapes bash operands
 * take: quoted (`cat '.env'`), glob-suffixed (`cat .env*`), and glued to a short
 * option (`grep -f.env`). Returns the offending token, or undefined.
 */
function findHazardousOperand(tokens: string[], dotglob = false): string | undefined {
  for (const raw of tokens) {
    if (!raw) continue;
    const t = unquote(raw);
    if (!t) continue;
    const candidates = new Set<string>([t]);
    const eq = t.indexOf("=");
    if (eq >= 0) candidates.add(t.slice(eq + 1)); // --file=.env
    const glued = /^-[A-Za-z]+(.+)$/.exec(t);
    if (glued) candidates.add(glued[1]!); // -f.env
    for (const c of candidates) {
      if (c && isHazardousFile(c)) return raw;
    }
    for (const c of candidates) {
      if (globHazard(c, dotglob)) return raw; // broad or dot-targeted: a glob is a path token too
    }
  }
  return undefined;
}

/** Basenames/paths `isHazardousFile` protects — used to decide whether a glob
 *  operand could match one of them at runtime. */
const HAZARDOUS_SAMPLES = [
  ".env", ".env.local", ".env.prod", ".envrc", ".npmrc", ".pypirc", ".netrc", ".dockercfg",
  "id_rsa", "id_ed25519", "id_ecdsa", "key.pem", "credentials.json", "credentials.yaml",
  "credentials.yml", "secrets.json", "secrets.yaml", "secrets.yml",
  ".ssh/id_rsa", ".gnupg/gpg-agent.conf", ".aws/credentials", ".docker/config.json",
];

/** Ordinary names a glob may legitimately reach — their presence in the match
 *  set means the glob is broad (`cat *`), not aimed at a protected name. */
const GLOB_BENIGN_SAMPLES = ["a", "README.md", "foo.txt", "x.ts", "node_modules", "package.json"];

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[.+^${}()|\\]/, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Classify a glob operand: `hazard` when the names it can reach are all
 *  protected (`cat .e*`, `cat .*`), `broad` when it reaches protected names and
 *  plain files alike (`cat *` — bash globs reach `id_rsa`, `credentials.json`),
 *  null when it cannot reach a protected name at all. Flat-denied either way:
 *  `cat id_rsa` is non-askable, so `cat *` must not smuggle it in.
 *  Matching follows bash's dot rule per segment: a pattern segment that does
 *  not start with a dot never matches a name that does (so `*` cannot reach
 *  `.env`; `*.env` is likewise safe).
 */
function globHazard(pattern: string, dotglob = false): "hazard" | "broad" | null {
  if (!/[*?\[]/.test(pattern)) return null;
  const pSegs = pattern.split("/");
  const reaches = (sample: string) => {
    const sSegs = sample.split("/");
    if (pSegs.length !== sSegs.length) return false;
    return pSegs.every((seg, i) => {
      const s = sSegs[i]!;
      if (s.startsWith(".") && !seg.startsWith(".") && !dotglob) return false; // bash dot rule
      return globToRegex(seg).test(s);
    });
  };
  if (!HAZARDOUS_SAMPLES.some(reaches)) return null;
  return GLOB_BENIGN_SAMPLES.some(reaches) ? "broad" : "hazard";
}

/**
 * Verbs whose write effect is confined to their path operands. When every
 * operand resolves inside the session scratch dir, the command touches
 * scratch space only and can run without approval. An explicit `deny` rule
 * still wins, and a hazardous name still hard-denies.
 */
const SANDBOX_WRITE_VERBS = new Set([
  "mkdir", "touch", "rm", "rmdir", "cp", "mv", "ln",
  "sed", "tee", "dd", "chmod", "chown",
]);

/** Interpreters that run a script FILE (never inline code) — see
 *  `sandboxScriptTarget`, which rejects `-e`/`-c`. */
const SCRIPT_RUNNERS = new Set([
  "bun", "bunx", "node", "deno", "python", "python3", "bash", "sh",
  "zsh", "dash", "ruby", "perl", "tsx", "ts-node",
]);

/** Path-shaped enough to be a script file, so package-script names (`test`,
 *  `build:honker`) are not mistaken for one. */
function looksLikeScriptPath(word: string): boolean {
  return word.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(word);
}

/** Resolve a write verb's path operands, or null when the subcommand is not a
 *  statically-resolvable write (unresolvable operands fail closed). */
function sandboxWriteOperands(
  verb: string,
  tokens: string[],
  dwords: string[],
  vars: VarMap,
  cwd: string,
): string[] | null {
  if (!SANDBOX_WRITE_VERBS.has(verb)) return null;
  const resolveAll = (indexes: number[]): string[] | null => {
    const out: string[] = [];
    for (const j of indexes) {
      const resolved = resolveDisplayWord(dwords[j]!, vars, cwd);
      if (resolved === undefined) return null;
      out.push(resolved);
    }
    return out.length > 0 ? out : null;
  };

  if (verb === "sed") {
    // Only in-place edits write. `sed -n` / `sed 's/a/b/' f` do not.
    const inPlace = tokens
      .slice(1)
      .some((t) => t === "-i" || t.startsWith("-i.") || t.startsWith("--in-place"));
    if (!inPlace) return null;
    const text = textOperandIndexes("sed", tokens);
    const idx: number[] = [];
    for (let j = 1; j < dwords.length; j++) {
      if (dwords[j]!.startsWith("-") || text.has(j)) continue;
      idx.push(j);
    }
    return resolveAll(idx);
  }

  if (verb === "dd") {
    const idx: number[] = [];
    for (let j = 1; j < dwords.length; j++) if (dwords[j]!.startsWith("of=")) idx.push(j);
    return resolveAll(idx)?.map((p) => p.slice(3)) ?? null;
  }

  if (verb === "chmod" || verb === "chown") {
    // First non-flag operand is the mode/owner (text); the rest are paths.
    let sawText = false;
    const idx: number[] = [];
    for (let j = 1; j < dwords.length; j++) {
      if (dwords[j]!.startsWith("-")) continue;
      if (!sawText) {
        sawText = true;
        continue;
      }
      idx.push(j);
    }
    return resolveAll(idx);
  }

  const idx: number[] = [];
  for (let j = 1; j < dwords.length; j++) {
    if (dwords[j]!.startsWith("-")) continue;
    idx.push(j);
  }
  return resolveAll(idx);
}

/** "local" = this session's scratch dir; "sibling" = the shared scratch tree
 *  but another session's dir (retarget nudge, not a user prompt). */
type ScratchTarget = "local" | "sibling" | null;

function classifyScratchPath(path: string, cwd: string): ScratchTarget {
  if (isWithinSandbox(path, cwd)) return "local";
  if (isWithinScratchBase(path, cwd)) return "sibling";
  return null;
}

/** A write subcommand whose operands all land in scratch. */
function sandboxTargetOfCommand(
  tokens: string[],
  dwords: string[],
  vars: VarMap,
  cwd: string,
): ScratchTarget {
  const verb = tokens[0];
  if (!verb) return null;
  const operands = sandboxWriteOperands(verb, tokens, dwords, vars, cwd);
  if (!operands) return null;
  let local = 0;
  let sibling = 0;
  for (const op of operands) {
    const t = classifyScratchPath(op, cwd);
    if (t === "local") local++;
    else if (t === "sibling") sibling++;
    else return null; // one outside operand makes the whole command non-scratch
  }
  if (sibling > 0) return "sibling";
  return local > 0 ? "local" : null;
}

/** A command that executes a script file from scratch (not inline code). */
function sandboxScriptTarget(
  tokens: string[],
  dwords: string[],
  vars: VarMap,
  cwd: string,
): ScratchTarget {
  if (!tokens.length) return null;
  const runner = tokens[0]!;
  // Direct execution: `./x.sh`, `/abs/x.sh`, `~/x.sh`.
  if (
    runner.startsWith("./") ||
    runner.startsWith("../") ||
    runner.startsWith("/") ||
    runner.startsWith("~")
  ) {
    if (!looksLikeScriptPath(runner)) return null;
    const resolved = resolveDisplayWord(dwords[0]!, vars, cwd);
    return resolved ? classifyScratchPath(resolved, cwd) : null;
  }
  if (!SCRIPT_RUNNERS.has(runner)) return null;
  // Inline code is not a scratch file; it can write anywhere.
  if (tokens.slice(1).some((t) => t === "-e" || t === "--eval" || t === "-c" || t === "-p")) {
    return null;
  }
  // First positional after flags and an optional `run`/`exec` subcommand.
  let scriptAt = -1;
  for (let j = 1; j < dwords.length; j++) {
    const w = dwords[j]!;
    if (w.startsWith("-")) continue;
    if (scriptAt === -1 && (w === "run" || w === "exec")) continue;
    if (!looksLikeScriptPath(w)) return null;
    scriptAt = j;
    break;
  }
  if (scriptAt === -1) return null;
  const resolved = resolveDisplayWord(dwords[scriptAt]!, vars, cwd);
  return resolved ? classifyScratchPath(resolved, cwd) : null;
}

/** Model-facing correction for a write aimed at another session's scratch. */
function scratchNudge(): string {
  const dir = getSandboxDir();
  return dir
    ? `That path is outside this session's scratch dir. Use ${dir}/ for scratch files.`
    : "That path is outside the project and is not this session's scratch dir.";
}

/**
 * Whether a bash token names a path outside `cwd`. Loose on purpose: it treats
 * any non-flag token containing a slash as a path and lets `isExternalPath`
 * resolve it, so interior `..` segments are normalized before comparison.
 * A glob token is probed by its non-glob prefix (`/etc/*` -> `/etc/`).
 */
function isExternalPathOperand(raw: string, cwd: string): boolean {
  const t = unquote(raw);
  if (!t || t.startsWith("-") || t.includes("://")) return false;
  const globAt = t.search(/[*?[\]{}]/);
  const probe = globAt >= 0 ? t.slice(0, globAt) : t;
  if (!probe.includes("/")) return false;
  return isExternalPath(probe, cwd);
}

export function checkBashPermission(
  command: string,
  profile: ProfileName,
  rules: Ruleset,
  cwd?: string,
  trustExternalPaths = false,
  modeAliases: ModeAliases = {},
  /** Accepted inferred rules (structural bash patterns). Consulted only
   *  when the explicit ruleset says "ask" — an explicit deny always wins. */
  inferred?: InferredBashRule[],
): PermissionCheck {
  const parsed = parseCommand(command);

  // Fail closed: if the parser could not produce a trustworthy result, deny
  // rather than treating an empty/partial parse as an allow.
  if (parsed.parseFailed) {
    return { action: "deny", reason: "Could not parse bash command; denied to be safe", unapproved: [], unforceable: true };
  }

  if (parsed.catastrophic) {
    return { action: "deny", reason: "Catastrophic command", unapproved: [], unforceable: true };
  }

  const absCwd = cwd ?? process.cwd();

  // In read-only modes, deny bash commands that are functionally equivalent
  // to the edit/write tools (which are disabled in read-only modes).
  // This prevents circumvention via heredoc+redirect, sed -i, tee,
  // interpreter -c/-e, etc.
  if ((profile === "plan" || profile === "ro") && isEditLikeBashCommand(command, parsed, absCwd)) {
    const label = profile === "ro" ? "Read-only mode" : "Plan mode";
    return {
      action: "deny",
      reason: `${label}: bash command writes to a file (equivalent to edit/write tool)`,
      modeDenied: true,
    };
  }

  const unapproved: string[] = [];
  const unapprovedDisplay: string[] = [];
  // Subcommands allowed by an exact-shape rule. The dangerous-verb gate at the
  // bottom still escalates these when ONLY a broad rule matched, but must
  // yield to an exact-shape approval or approval could never stick.
  const exactShapeAllowed = new Set<string>();
  const redirectTargets: Array<{ permission: "read" | "edit"; path: string }> = [];
  const denyReasons: string[] = [];
  let worstAction: PermissionAction = "allow";
  let hazardous = false;

  // Variable state for `$F`-shaped operands: bare assignments update it in
  // order, everything else is resolver from the ambient environment.
  const vars = newVarMap(absCwd);
  // Effective working directory inside a compound command. A `cd` changes how
  // later relative operands resolve; without this, `cd <scratch> && rm x`
  // resolved `x` against the project root and asked.
  let effectiveCwd = absCwd;
  let cwdKnown = true;
  // A retarget nudge replaces the user prompt only when EVERY ask in the
  // command is a scratch-scope miss. Any genuine ask forces the prompt.
  let narrowHint: string | undefined;
  let hardAsk = false;
  const recordAsk = (sub: string, index: number): void => {
    if (worstAction !== "deny") worstAction = "ask";
    if (!unapproved.includes(sub)) {
      unapproved.push(sub);
      unapprovedDisplay.push(parsed.displaySubcommands[index] ?? sub);
    }
  };

  for (let i = 0; i < parsed.subcommands.length; i++) {
    const sub = parsed.subcommands[i]!;
    const tokens = parsed.subcommandWords[i] ?? [];
    const dwords = parsed.subcommandDisplayWords[i] ?? tokens;

    // `cd` is safe when it targets the project, the session scratch dir, or
    // the shared scratch tree (traversal only — writes are judged below).
    // Adopt a resolved target so later operands resolve against it.
    const cd = cdTargetOf(sub);
    let cdPath: string | null | undefined;
    // An absolute (or `~`) target does not depend on the shell's current
    // directory. A relative one does — and after `cd -` the directory is
    // unknowable, so it must not be auto-approved or adopted.
    const cdAbsolute = cd?.kind === "path" && (cd.target.startsWith("/") || cd.target.startsWith("~"));
    if (cd !== null) {
      if (cd.kind === "unknown") {
        // `cd -` goes to OLDPWD, which is not statically knowable.
        cdPath = null;
        cwdKnown = false;
        continue;
      }
      cdPath = resolveAbsolute(cd.target, effectiveCwd);
      const target = cdPath;
      // A bare `cd` goes to $HOME; the old behavior auto-approved it as a
      // harmless preamble. Adoption below makes later relative operands
      // resolve against $HOME (and therefore look external).
      const bareCd = sub.trim() === "cd";
      const safeTarget =
        bareCd ||
        ((cwdKnown || cdAbsolute) &&
          (trustExternalPaths ||
            target === absCwd ||
            target.startsWith(absCwd + "/") ||
            isWithinSandbox(target, absCwd) ||
            isWithinScratchBase(target, absCwd)));
      if (safeTarget) {
        effectiveCwd = target;
        cwdKnown = true;
        continue;
      }
      // External cd: fall through to the ruleset. If an explicit rule allows
      // it, the target is adopted below so the rest of the command resolves
      // against the new directory.
    }

    // Bare variable assignments (e.g. ORDER_ID=abc) update the resolution state
    // for later subcommands in the same command string — this is how
    // `F=.env; cat $F` gets caught — and are always safe themselves.
    // Command substitutions in values are extracted as separate subcommands.
    const bareUpdatesState =
      isBareAssignment(tokens) ||
      (tokens[0] === "export" && dwords.slice(1).every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)));
    if (bareUpdatesState) {
      for (const w of dwords) recordAssignment(w, vars, effectiveCwd);
      continue;
    }

    const displaySub = parsed.displaySubcommands[i] ?? sub;
    const result = evaluatePermission("bash", sub, profile, rules, displaySub, modeAliases);
    // Only file-touching verbs' operands can name a secured file or point
    // outside the project; text args (echo/git/printf/…) are never scanned.
    const verb = firstFileVerb(tokens);
    const candidates: string[] = [];
    let unresolvedOperand = false;
    if (verb) {
      const textSlots = textOperandIndexes(verb, tokens);
      for (let j = 0; j < dwords.length; j++) {
        if (textSlots.has(j)) continue;
        const resolved = resolveDisplayWord(dwords[j]!, vars, effectiveCwd);
        if (resolved === undefined) {
          // A `$F` operand we cannot pin down could be a secured file or an
          // external path — escalate, never allow silently.
          unresolvedOperand = true;
          continue;
        }
        // Unquoted expansions word-split; check each would-be word. Source
        // words without `$` are literal and check as a whole.
        const segments = dwords[j]!.includes("$") ? resolved.split(/\s+/) : [resolved];
        for (const part of segments) if (part) candidates.push(part);
      }
    }
    // A hazardous file named anywhere in the subcommand is a hard deny, whatever
    // the ruleset verdict — the file tools and bash redirects block these, and an
    // allowlisted verb must not read them silently. Runs before the action branch
    // so `rm .env` (verdict ask) is blocked too.
    const hazardOperand = verb
      ? findHazardousOperand(candidates, command.includes("dotglob"))
      : undefined;
    // Scratch-local writes and script runs (this session's dir) run silently;
    // a write aimed at another session's scratch is a retarget nudge, not a
    // user decision.
    const scratchTarget = cwdKnown && result.action !== "deny" && !hazardOperand
      ? sandboxTargetOfCommand(tokens, dwords, vars, effectiveCwd)
        ?? sandboxScriptTarget(tokens, dwords, vars, effectiveCwd)
      : null;
    if (hazardOperand) {
      worstAction = "deny";
      hazardous = true;
      if (!denyReasons.includes(HAZARDOUS_REASON)) denyReasons.push(HAZARDOUS_REASON);
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
    } else if (scratchTarget === "local") {
      // Scratch-local write or script run: touches this session's scratch only.
    } else if (scratchTarget === "sibling") {
      narrowHint ??= scratchNudge();
      recordAsk(sub, i);
    } else if (
      verb &&
      unresolvedOperand &&
      // A deny verdict always wins (fall through to the deny branch below),
      // and an explicit approval of this exact subcommand shape overrides the
      // escalation — or approval could never stick and every recheck would
      // re-ask forever. Baseline catch-alls (e.g. `cat *`) still escalate:
      // they must not silently authorize an unpinnable operand that could
      // name a secured file.
      result.action !== "deny" &&
      !(result.action === "allow" && isExplicitRule(result.matchedRule))
    ) {
      hardAsk = true;
      recordAsk(sub, i);
    } else if (result.action === "allow") {
      if (result.matchedRule !== undefined && isExactShapeRule(result.matchedRule)) {
        exactShapeAllowed.add(sub);
      }
      // Parity with the file tools: an allowlisted verb that names a path
      // outside the project root must be approved, not run silently. But only
      // baseline catch-all rules are downgraded (mirrors checkFileTarget) — a
      // rule the user explicitly approved must override, or approval could
      // never stick and every recheck would re-ask forever. Scratch paths
      // (this session's dir or the shared tree) never count as external.
      const externalOperand =
        !trustExternalPaths &&
        candidates.some((tok) => {
          if (isWithinSandbox(tok, effectiveCwd) || isWithinScratchBase(tok, effectiveCwd)) return false;
          if (!cwdKnown && tok.includes("/") && !tok.startsWith("/")) return true;
          return isExternalPathOperand(tok, effectiveCwd);
        });
      if (!isExplicitRule(result.matchedRule) && externalOperand) {
        hardAsk = true;
        recordAsk(sub, i);
      } else if (cdPath !== null && cdPath !== undefined && (cwdKnown || cdAbsolute)) {
        // An external `cd` allowed by an explicit rule: adopt it so the rest
        // of the compound command resolves against the new directory. A
        // relative target after `cd -` cannot be resolved safely.
        effectiveCwd = cdPath;
        cwdKnown = true;
      }
    } else if (result.action === "deny") {
      worstAction = "deny";
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
      const r = result.matchedRule?.reason ?? "Automatically denied";
      if (!denyReasons.includes(r)) denyReasons.push(r);
    } else if (result.action === "ask") {
      // Inferred rules may settle an ask (structural token match), but never
      // override a deny above.
      const inferredAllow = inferred?.length
        ? inferred.some(
            (r) =>
              inferredRuleApplies(r, profile, modeAliases) &&
              patternMatches(r.pattern, subcommandTokenLists(sub)[0] ?? []),
          )
        : false;
      if (!inferredAllow) {
        hardAsk = true;
        recordAsk(sub, i);
      }
    }
  }

  for (const target of parsed.redirects) {
    const perm = target.direction === "input" ? "read" : "edit";
    const targetResult = checkFileTarget(target.path, perm, profile, rules, effectiveCwd, trustExternalPaths, modeAliases);
    if (targetResult.action === "deny") {
      worstAction = "deny";
      redirectTargets.push({ permission: perm, path: target.path });
      if (targetResult.hazardous) hazardous = true;
      if (targetResult.reason && !denyReasons.includes(targetResult.reason)) {
        denyReasons.push(targetResult.reason);
      }
    } else if (targetResult.action === "ask") {
      // A write redirect into another session's scratch is the same retarget
      // mistake as a sibling `rm`/`mkdir`: nudge, don't prompt.
      if (perm === "edit" && cwdKnown && isWithinScratchBase(target.path, effectiveCwd) && !isWithinSandbox(target.path, effectiveCwd)) {
        narrowHint ??= scratchNudge();
        if (worstAction !== "deny") worstAction = "ask";
      } else {
        hardAsk = true;
        if (worstAction !== "deny") worstAction = "ask";
        redirectTargets.push({ permission: perm, path: target.path });
      }
    }
  }

  // A dangerous verb with an operand that cannot be resolved statically
  // (e.g. `rm -rf "$DIR"`) must not be silently allowed by a broad rule.
  // An exact-shape approval of the very subcommand being run overrides this
  // (same rationale as above); broad rules never do.
  // Only the subcommands that actually carry the unresolvable operand are
  // escalated: flagging the whole compound command would force approval for
  // the harmless remainder too, so an approval of the offending subcommands
  // could never satisfy the post-approval recheck.
  if (parsed.dangerousUnresolvedOperands.length > 0 && worstAction === "allow") {
    for (const sub of parsed.dangerousUnresolvedOperands) {
      if (exactShapeAllowed.has(sub)) continue;
      const i = parsed.subcommands.indexOf(sub);
      worstAction = "ask";
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push((i >= 0 ? parsed.displaySubcommands[i] : undefined) ?? sub);
      }
    }
  }

  const result: PermissionCheck = { action: worstAction, unapproved, unapprovedDisplay, redirectTargets };
  if (hazardous) result.hazardous = true;
  const opaque = unapproved.filter((s) => parsed.opaqueSubcommands.includes(s));
  if (opaque.length > 0) result.opaquePayload = opaque;
  if (worstAction === "ask" && narrowHint !== undefined && !hardAsk && !hazardous) {
    result.narrow = narrowHint;
  }
  if (worstAction === "deny" && denyReasons.length > 0) {
    result.reason = denyReasons.join("; ");
  }
  return result;
}
export function checkToolPermission(
  toolName: string,
  profile: ProfileName,
  rules: Ruleset,
  modeAliases: ModeAliases = {},
  /** Accepted inferred rules (structural patterns). Consulted only when the
   *  explicit ruleset says "ask" — the same contract as checkBashPermission,
   *  so tool calls get the same inferred-rule affordances as bash commands. */
  inferred?: InferredBashRule[],
): PermissionCheck {
  const target = `tool:${toolName}`;
  const result = evaluatePermission("bash", target, profile, rules, undefined, modeAliases);
  if (result.action === "deny") {
    return { action: "deny", reason: result.matchedRule?.reason ?? "Unknown tool denied by ruleset" };
  }
  if (result.action === "ask") {
    const inferredAllow = inferred?.length
      ? inferred.some(
          (r) =>
            inferredRuleApplies(r, profile, modeAliases) &&
            patternMatches(r.pattern, subcommandTokenLists(target)[0] ?? []),
        )
      : false;
    if (inferredAllow) return { action: "allow" };
    const modeLabel = profile === "plan" ? "plan mode" : profile === "ro" ? "read-only mode" : `${profile} mode`;
    return { action: "ask", reason: `Unknown tool in ${modeLabel} requires approval` };
  }
  return { action: result.action };
}
