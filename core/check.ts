import { resolve } from "node:path";
import type { ProfileName, PermissionAction, Rule, Ruleset, ModeAliases } from "./types.ts";
import { evaluatePermission } from "./permissions/ruleset.ts";
import { getBaselineRules } from "./permissions/index.ts";
import { parseCommand, subcommandTokenLists, isHazardousFile, isEditLikeBashCommand } from "./bash-parser.ts";
import { normalizePathForMatching, expandHome, isExternalPath } from "./project.ts";
import { newVarMap, resolveDisplayWord, recordAssignment } from "./expansion.ts";
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
 *  checked independently. */
function isBareAssignment(subcommand: string): boolean {
  const tokens = subcommand.trim().split(/\s+/);
  return tokens.length > 0
    && tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
}

/**
 * Check whether a subcommand is `cd <path>` where <path> resolves to
 * cwd or a directory below it.  Such commands are always safe and
 * auto-approved. When `trustExternalPaths` is set, cd to ANY directory
 * (including those outside cwd) is auto-approved.
 */
function isCdWithinProject(subcommand: string, cwd: string, trustExternalPaths = false): boolean {
  const trimmed = subcommand.trim();
  if (trimmed === "cd") return true; // bare cd → $HOME, harmless

  const cdMatch = trimmed.match(/^cd\s+(.+)$/);
  if (!cdMatch) return false;

  let target = cdMatch[1]!.trim();

  // Strip quotes
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }

  target = expandHome(target);

  // Resolve relative paths against cwd.
  const resolved = target.startsWith("/") ? target : resolve(cwd, target);

  // Target must be within or equal to cwd. When external paths are
  // trusted, auto-approve cd to any directory.
  return trustExternalPaths || resolved.startsWith(cwd + "/") || resolved === cwd;
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
    return { action: "deny", reason: "Could not parse bash command; denied to be safe", unapproved: [] };
  }

  if (parsed.catastrophic) {
    return { action: "deny", reason: "Catastrophic command", unapproved: [] };
  }

  // In read-only modes, deny bash commands that are functionally equivalent
  // to the edit/write tools (which are disabled in read-only modes).
  // This prevents circumvention via heredoc+redirect, sed -i, tee,
  // interpreter -c/-e, etc.
  if ((profile === "plan" || profile === "ro") && isEditLikeBashCommand(command, parsed)) {
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

  const absCwd = cwd ?? process.cwd();
  // Variable state for `$F`-shaped operands: bare assignments update it in
  // order, everything else is resolver from the ambient environment.
  const vars = newVarMap(absCwd);

  for (let i = 0; i < parsed.subcommands.length; i++) {
    const sub = parsed.subcommands[i]!;
    // Auto-approve cd when the target is within (or equal to) cwd.
    // cd to the project or a subdirectory is always safe and the LLM
    // frequently emits it as a preamble (e.g. "cd <cwd> && git diff").
    if (isCdWithinProject(sub, absCwd, trustExternalPaths)) continue;

    const tokens = parsed.subcommandWords[i] ?? [];
    const dwords = parsed.subcommandDisplayWords[i] ?? tokens;

    // Bare variable assignments (e.g. ORDER_ID=abc) update the resolution state
    // for later subcommands in the same command string — this is how
    // `F=.env; cat $F` gets caught — and are always safe themselves.
    // Command substitutions in values are extracted as separate subcommands.
    const bareUpdatesState =
      isBareAssignment(sub) ||
      (tokens[0] === "export" && dwords.slice(1).every((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)));
    if (bareUpdatesState) {
      for (const w of dwords) recordAssignment(w, vars, absCwd);
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
        const resolved = resolveDisplayWord(dwords[j]!, vars, absCwd);
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
    if (verb && findHazardousOperand(candidates, command.includes("dotglob"))) {
      worstAction = "deny";
      hazardous = true;
      if (!denyReasons.includes(HAZARDOUS_REASON)) denyReasons.push(HAZARDOUS_REASON);
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
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
      if (worstAction !== "deny") worstAction = "ask";
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
    } else if (result.action === "allow") {
      if (result.matchedRule !== undefined && isExactShapeRule(result.matchedRule)) {
        exactShapeAllowed.add(sub);
      }
      // Parity with the file tools: an allowlisted verb that names a path
      // outside the project root must be approved, not run silently. But only
      // baseline catch-all rules are downgraded (mirrors checkFileTarget) — a
      // rule the user explicitly approved must override, or approval could
      // never stick and every recheck would re-ask forever.
      const externalOperand = !trustExternalPaths && candidates.some((tok) => isExternalPathOperand(tok, absCwd));
      if (!isExplicitRule(result.matchedRule) && externalOperand) {
        if (worstAction !== "deny") worstAction = "ask";
        if (!unapproved.includes(sub)) {
          unapproved.push(sub);
          unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
        }
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
        if (worstAction !== "deny") worstAction = "ask";
        if (!unapproved.includes(sub)) {
          unapproved.push(sub);
          unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
        }
      }
    }
  }

  for (const target of parsed.redirects) {
    const perm = target.direction === "input" ? "read" : "edit";
    const targetResult = checkFileTarget(target.path, perm, profile, rules, cwd, trustExternalPaths, modeAliases);
    if (targetResult.action === "deny") {
      worstAction = "deny";
      redirectTargets.push({ permission: perm, path: target.path });
      if (targetResult.hazardous) hazardous = true;
      if (targetResult.reason && !denyReasons.includes(targetResult.reason)) {
        denyReasons.push(targetResult.reason);
      }
    } else if (targetResult.action === "ask") {
      if (worstAction !== "deny") worstAction = "ask";
      redirectTargets.push({ permission: perm, path: target.path });
    }
  }

  // A dangerous verb with an operand that cannot be resolved statically
  // (e.g. `rm -rf "$DIR"`) must not be silently allowed by a broad rule —
  // force approval instead. An exact-shape approval of the very subcommand
  // being run overrides this (same rationale as above); broad rules never do.
  if (parsed.forceAsk && worstAction === "allow") {
    for (let i = 0; i < parsed.subcommands.length; i++) {
      const sub = parsed.subcommands[i]!;
      if (exactShapeAllowed.has(sub)) continue;
      worstAction = "ask";
      if (!unapproved.includes(sub)) {
        unapproved.push(sub);
        unapprovedDisplay.push(parsed.displaySubcommands[i] ?? sub);
      }
    }
  }

  const result: PermissionCheck = { action: worstAction, unapproved, unapprovedDisplay, redirectTargets };
  if (hazardous) result.hazardous = true;
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
