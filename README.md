# pi-safetynet

![MutuaL-1.2](https://img.shields.io/badge/License-MutuaL--1.2-af2e1a?style=flat&labelColor=110402&link=https%3A%2F%2Fcodeberg.org%2FMutualism%2FMutualist-License)

A permissions and safety extension for [Pi](https://pi.dev) that understands what your AI agent is trying to do.

## Install & packages

This repo is a small monorepo: two independently installable pi packages plus their shared runtime.

```
packages/pi-safetynet       permission engine, prompts, modes, auto-approve reviewer
packages/pi-submarine       the subagent_* tools (persistent background subagents)
packages/pi-submarine-core  shared session runtime + the SafetynetHost contract
```

- `pi install npm:<you>/pi-safetynet` — permissions only; no `subagent_*` tools are offered to the model.
- `pi install npm:<you>/pi-submarine` — background subagents only, under a simple confirm policy.
- Both installed: pi-submarine's children run under pi-safetynet's ruleset (shared approvals, bridged prompts) and follow the live mode.

Each package entry is its own `pi config` row, so either half can be toggled off or removed independently.
Developing from a checkout needs no install step: run `npm install` once for the workspace links, point
your `extensions` setting at the checkout, and pi executes `packages/*/index.ts` straight from source.

The cooperation surface is `SafetynetHost`, published on `pi.events`: live mode/config getters and the
child permission-gate factory. It is exactly the contract a fully standalone subagent extension consumes.

## The problem

In my experience, many harness permissions plugins treat shell commands as opaque strings — they see `"rm"` and flag it, or see `"sudo"` and flag it, but don't parse what's actually happening inside a pipeline, a redirect, or a `xargs` invocation. I've observed gaps like:

- `echo hello > /etc/passwd` sailing through because `echo` is "safe"
- `find . -name '*.ts' | xargs rm` getting approved because `find` is "safe"
- `sed -i s/foo/bar/ file.txt` treated the same as `sed -n 5p file.txt`
- `cat <<EOF > file.txt` heredoc writes going unnoticed
- `python3 -c "open('f','w').write('hi')"` being invisible because the guard only sees `python3`

These approaches tend to protect words, not actions.

## What pi-safetynet does differently

pi-safetynet takes two key approaches: **AST-aware command analysis** that parses what commands actually *do* rather than matching strings, and a **plan/build profile system** that lets you run the agent read-only until you explicitly allow changes.

Every bash command is parsed into a proper **AST** using [tree-sitter](https://tree-sitter.github.io/) (via `web-tree-sitter` + the `tree-sitter-bash` grammar) and security decisions are made based on what the command *does*, not what strings it contains.

![pi-safetynet permission prompt](assets/screenshot-permission-request.png)

### AST-aware command analysis

Every `bash` tool call is parsed and decomposed into its constituent parts:

| What pi-safetynet extracts | Example | Why it matters |
|---|---|---|
| **Subcommands** in pipes/`&&`/`||` | `ls \| grep foo` → `[ls, grep foo]` | Each command is evaluated independently against the ruleset |
| **Output redirects** | `cmd > out.txt` → `edit: out.txt` | Redirects to real files are treated as edits — writing to a file is writing to a file |
| **Input redirects** | `sort < .env` → `read: .env` | Input redirects go through read-permission checks, catching secret file access |
| **xargs inner commands** | `xargs -0 rm` → `rm` | The *actual* command inside xargs is what gets evaluated, not `xargs` itself |
| **timeout inner command** | `timeout 10 rm` → `[timeout 10, rm]` | The wrapper (`timeout <dur>`) is preapproved; the inner command is evaluated normally |
| **sudo + underlying command** | `sudo rm file` → `sudo rm file` | sudo is always kept as a prefix; the inner command is still evaluated |
| **find -exec/-delete** | `find . -exec rm {} \;` → `find:exec` | `find` with destructive actions gets a dedicated classification |
| **Command substitutions** | `echo "$(whoami)"` → `[echo ..., whoami]` | Subcommands inside `$()` are recursively extracted |
| **Process substitutions** | `diff <(sort a) <(sort b)` → `[diff, sort a, sort b]` | Commands inside `<()` are recursively extracted |
| **Test expressions** | `[[ -f /etc/passwd ]]` → `read: /etc/passwd` | File-test operators are treated as file reads |
| **Heredoc bodies** | `cat <<EOF > file.txt` → redirect to `file.txt` | Heredoc bodies are stripped and the surrounding structure is still parsed |

#### A note on AST vs. string patterns

The AST tells us *what* is running — but when you approve a command, what gets saved as a rule is the **stringified form** of that subcommand, matched with a wildcard pattern. For example, approving `npm install express` creates a rule like `npm install *`.

This means the rules are still fundamentally string patterns, not structured command definitions. We haven't built something like "always allow `-p` for `mkdir`" because canonicalizing command representation would require knowing every flag of every possible shell command — which isn't practical. `mkdir -p src/lib` and `mkdir src/lib` are different strings, and without a flag database per command, we can't know they should be treated the same.

This is half a UI problem too: even if we could parse apart flags from positional args, how do you surface that to the user in a way that's useful and not overwhelming? For now, the wildcard pattern approach (`mkdir *` auto-approves all mkdir invocations) is a reasonable tradeoff between precision and usability.

### Plan / Build profiles

pi-safetynet provides a two-tier security model so you can keep the agent read-only until you're ready:

**Plan mode** (default) — `edit` and `write` tools are disabled. Read-only bash commands are auto-approved. Edit-equivalent bash commands (redirects, `sed -i`, interpreter one-liners, etc.) are **denied**, not just asked about. External file access requires approval.

**Build mode** — Full tool access. Allowlisted commands run silently. Unknown commands prompt for approval. Catastrophic commands are always blocked. Escalation from plan to build requires your approval; de-escalation is automatic.

**Auto-approve** — `/safetynet:auto` toggles automatic permission approval. When enabled, every action the ruleset flags as Ask is routed to a configurable permissions model (a read-only subagent with read/grep/find/ls) that judges the action against a risk policy instead of prompting the user. It runs alongside whatever profile (plan or build) you're in — status shows `+auto`.

The reviewer returns a JSON assessment `{risk_level, user_authorization, outcome, rationale}`:

- It judges against the **user's own messages only** — the transcript it sees contains just the human conversation, never the assistant's tool calls or outputs, so its own momentum can't look like consent. It can still verify local state itself with read-only tools.
- **Egress is high risk.** Pushing to a remote, connecting to a host, publishing, or deploying to a destination the user never named is treated as unauthorized egress and denied, not waved through as routine.
- **Authorization defaults to `unknown`.** Only the user's own messages establish `user_authorization`; a missing score defaults to `unknown` rather than guessing lenient.
- **Allow** — creates a turn-scoped temp rule so repeats in the same turn skip re-review. The model sees a hidden nudge. A shell-glob command, or one where some subcommands were skipped, is approved for that call only — no rule is minted.
- **Deny** — blocks with the rationale, keeps the turn alive so the model can try a safer alternative. After `autoApprove.maxDenials` consecutive reviewer denials (default 3) the turn is aborted. Denials that touch a sensitive file (e.g. `cat .env`) are exempt from that budget. Ruleset, read-only/mode, and headless denials use a separate per-turn budget (`autoDeny.maxStrikes`); hazardous-file denials never abort at all.
Every denial is surfaced in two places:
- **On the rejected tool call** — the blocked call's error result reads `Auto-denied <permission>: <target> — <rationale>` (a `Ruleset denied …` or `Denied …` prefix for deny-rule/headless denials). The reviewer's internal risk/authorization scores are not shown.
- **To the model** — a hidden transcript message carries the same line so the reason reaches the model even when the denial aborts the turn, plus a one-line corrective instruction keyed to the denial source (mode denials: propose the change and let the user switch modes; ruleset/headless denials: stop retrying, explain what you need). When the denial aborts, the message is also rendered as a visible transcript entry next to the rejected call.
- **Infrastructure failure** (timeout, API error, unparseable) — falls back to the interactive permission prompt with a notice. The reviewer does not retry and cannot auto-resolve the prompt: once escalated, the user decides. A stale or delayed model verdict can never convert a prompt dismissal into an approval.

Configure which model handles review and timeouts in global config:

```json
{ "autoApprove": { "model": "provider/model-id", "timeoutMs": 90000, "maxDenials": 3 } }
```


### Catastrophic command blocking

System-destroying commands are **always denied**, regardless of profile or ruleset:

- `rm -rf /` / `rm -rf /usr` / `rm -rf /etc` / `rm -rf ~` / `rm -rf /*` / `rm --no-preserve-root`
- `chmod` / `chown` on protected directories
- `sudo` variants of all the above (with proper flag skipping — `sudo -u root rm /etc` is still caught)
- `xargs` variants (`xargs rm -rf /` is still catastrophic)
- `mkfs.*`, `dd of=/dev/`, `shutdown`, `reboot`, `halt`, `poweroff`

**Best-effort, not a security boundary.** This is a denylist over an open-ended command language, so it cannot catch every spelling (shell functions, aliases, `eval`, dynamically built command names, expansions). It only ever overrides a rule that would otherwise match. The real guarantee is that unmatched commands ask — or deny when no rules exist. Don't rely on this to stop a determined command.

### Edit-equivalent bash detection

In **plan mode**, pi-safetynet doesn't just disable the `edit` and `write` tools — it also detects bash commands that are functionally equivalent to editing a file:

| Technique | Caught as "edit-like" |
|---|---|
| Output redirects (`>`, `>>`, `&>`, `>\|`, `<>`) | ✅ Redirect target goes through edit permission |
| Heredoc writes (`cat <<EOF > file`) | ✅ Heredoc body stripped, redirect still detected |
| `sed -i` / `perl -pi` / `perl -pe` | ✅ In-place edit flags detected |
| `tee` / `truncate` / `install` / `dd` | ✅ Write-purpose commands flagged |
| `python3 -c` / `node -e` / `ruby -e` / `perl -e` / `php -r` | ✅ Interpreter one-liners can embed arbitrary I/O |
| `sh -c` / `bash -c` | ✅ Subshell execution with code strings |
| Redirections to `/dev/null` and friends | ❌ Safe device files are excluded |

**Same caveat as catastrophic blocking:** this is a best-effort heuristic, not a guarantee. A write mechanism the detector doesn't recognize falls back to the normal ruleset — which asks unless a rule matches. It is not a sandbox; for a hard "no writes" boundary, use plan/ro with a tight read-only allowlist, or run in a container. The one built-in exception is the [session scratch space](#session-scratch-space), which stays writable in every mode.

### Session scratch space

Every session gets a private scratch directory — `<os.tmpdir()>/pi-safetynet/<sessionId>/`, created `0700` at session start — and **both read-only and read-write modes allow reads and writes there**. It exists so throwaway files (command output, intermediate artifacts, code handed to a sandboxed tool) don't need an approval prompt:

```
curl -s https://example.com > "$TMPDIR/pi-safetynet/…/page.html"
grep -n TODO src/**/*.ts > /tmp/pi-safetynet/…/todos.txt
```

Allowed inside the sandbox:

- Output and input redirects (`>`, `>>`, `<`), including in plan/ro mode where they would otherwise be denied as edit-like.
- The `read`, `edit`, and `write` tools.
- `cd` into the sandbox.
- Sandbox-local file management: `mkdir`, `touch`, `rm`, `rmdir`, `cp`, `mv`, `ln` when every path operand resolves inside the sandbox.

Not allowed:

- Hazardous names (`.env`, `id_rsa`, credentials, …) stay denied inside the sandbox too. The guard is a pure path-name check, so exempting the sandbox would require resolving what a path actually points at — a symlink or hardlink, or a copy that planted a real secret under a trusted name — which is not statically decidable.
- Paths outside the sandbox, including a sibling that merely shares the prefix (`/tmp/pi-safetynet/abc-evil` is not inside `/tmp/pi-safetynet/abc`).
- Variable, `cd`-relative, and glob operands that can't be pinned to the sandbox statically fail closed and prompt as usual.

The path is computed once per session and is stable, so it does not churn the cached system-prompt prefix. Subagents share the parent session's sandbox. Nothing is cleaned up automatically; `/tmp` reclaims it.

### Hazardous file protection

pi-safetynet automatically denies access to sensitive files, regardless of tool:

- `.env`, `.env.production`, `.env.local` (but not `.env.example`, `.env.sample`)
- `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.dockercfg`
- SSH keys (`id_rsa`, `id_ed25519`, `id_ecdsa`, `*.pem`)
- `credentials.json/yaml`, `secrets.json/yaml`
- Anything under `.ssh/`, `.gnupg/`, `.aws/credentials`, `.docker/config.json`

These are blocked at the file-permission level — whether accessed via `read`, `edit`, `bash`, or redirect.

Bash operands are only inspected for file-touching commands (`cat`/`head`/`grep`/`cp`/…): text arguments like `echo .env` or `git commit -m 'update .env'` are never treated as paths, and pattern/script arguments of `grep`/`rg`/`sed`/`awk`/`find` are skipped too (`grep -e '.env' f` is safe, `grep x .env` is not).

Operands built from shell variables are resolved statically: in-command assignments (`F=.env; cat $F`), exported environment variables (pi runs `bash -c <cmd>` in a fresh shell per tool call, so `process.env` is the shell's environment), and `$PWD`. An operand that cannot be pinned down — `$(…)`, arithmetic, unknown variables — asks rather than runs.

Globs are checked for reachability under bash's dot rule (a pattern without a leading `.` can never match a hidden name, unless `shopt -s dotglob` is set in the same command): `cat .e*`, `cat .*`, `cat *` (which reaches `id_rsa`) are denied flat, since `cat id_rsa` is non-askable itself; `cat *.env`, `cat README*`, `cat dist/*` are not.

Hazardous-file denials **never abort the conversation and never consume a budget**. The read/write stays blocked, but the turn continues so the model can recover (ask the user, use an env var) — ending the turn wouldn't stop it retrying next turn and would only strand you mid-task. This covers file-tool and redirect access, which are denied mechanically, and bash commands that merely name a secret (`cat .env`), where the auto-reviewer denies but is exempted from its abort budget. Every other auto-denial — explicit `deny` rules, read-only/mode write denials, and headless (no-TUI) denials — draws from one per-turn strike budget: each strike nudges the model, and the strike that exhausts the budget (`autoDeny.maxStrikes`, default **3**) aborts the turn. Each scope (main session, and each subagent independently) has its own budget, and the counter resets on `agent_end`.

### Redirect-aware permission checks

When a bash command includes file redirects, pi-safetynet enforces the corresponding file-level permission:

```
echo secret > .env
         └── parsed as: edit .env → DENIED (sensitive file: contains secrets, access blocked)

sort < /etc/passwd
     └── parsed as: read /etc/passwd → ASK (external path)

ls > out.txt
   └── parsed as: edit out.txt → ASK (edit catch-all)
```

I haven't seen another Pi permission plugin that parses redirects this way. pi-safetynet parses the AST and routes redirects through the correct permission tier.

### Project-boundary awareness

pi-safetynet detects your project root (the nearest `.pi/` directory) and treats paths outside it differently. Reads and writes to files inside the project follow the normal ruleset, but any access to files outside the project root — even reads that would otherwise be auto-approved by the `read: **` catch-all — requires explicit approval. This means `cat /etc/passwd` or `read` on `~/.ssh/config` will always prompt, even in build mode.

If you add a specific allow rule for an external path (e.g. `read: /etc/hosts`), that takes precedence and future accesses won't prompt.

You can disable the outside-cwd enforcement entirely with the `trustExternalPaths` setting. This is an **enforcement-only** flag: when enabled, all file paths are trusted the same as in-cwd paths (the `read: **` catch-all applies to external paths and `cd` to external directories is auto-approved), but path display logic is unchanged. Opt in via either the global config file or the CLI flag:

```json
{ "trustExternalPaths": true }
```

**Example:** `pi --trust-external-paths`

Hazardous-file protection (`.env`, `.ssh`, credentials, etc.) and catastrophic-command blocking are orthogonal and remain in effect.


## Approval durations

When pi-safetynet prompts for approval, you choose how long the permission lasts:

| Duration | Scope | Persistence |
|---|---|---|
| **Once** | This invocation only | Never saved — no rules created |
| **Turn** | Until the agent finishes its current turn | In-memory, cleared on `agent_end` |
| **Session** | Rest of this session | In-memory, survives across turns |
| **Project** | All future sessions in this project | Saved to `.pi/extensions/safetynet/approvals.json` |
| **Global** | All future sessions across all projects | Saved to `~/.config/pi-safetynet/config.json` |

## Permission prompts

The approval UI shows exactly what needs approval — individual subcommands in a pipeline, file redirects, or both. Each item can be toggled on/off, and items can be inline-edited before approval (e.g., narrow a `*` pattern to a specific path).

From the prompt you can either approve (with a chosen duration) or reject the call. There are two deny actions, each with its own shortcut:

- **Deny and abort** — ends the turn. The model stops and you get the prompt back. Bound to `denyAbort` (default: `Esc`).
- **Deny and continue** — non-aborting. The model keeps its turn and sees the deny reason as the tool's error result, so it can react (e.g. try a different command) without losing in-progress work. Bound to `denyContinue` (no default — see [Prompt keybindings](#prompt-keybindings) to enable). By default, use the `[Deny…]` row instead: arrow down to it, type a reason, and Enter to submit (empty Enter = deny with no reason).

When the deny editor is focused, `Esc` backs out to the duration selector without aborting (no matter how `denyAbort` is bound).

### Number shortcuts

From the duration selector, press `1`–`5` to pick a duration and approve immediately with the currently-checked items:

1. Once  ·  2. Session  ·  3. Project  ·  4. Turn  ·  5. Global

## Keyboard shortcuts

### Global shortcuts

These are pi global shortcuts (work outside the prompt too):

| Shortcut | Action | Configurable |
|---|---|---|
| `Ctrl+\` | Toggle between plan and build mode | yes — `toggleModeKey` |
| `Ctrl+Shift+\` | Show the current plan | no |

### Prompt keybindings

| Action | Default | Config field |
|---|---|---|
| Deny and abort | `escape` | `keybindings.denyAbort` |
| Deny and continue | *(unbound)* | `keybindings.denyContinue` |

Key identifiers use pi-tui's key-id form (the same form pi uses for its own keybindings): single chars like `"n"`, special keys like `"escape"`/`"enter"`, and modified keys like `"ctrl+c"` or `"shift+n"`. Note that pi-tui lowercases single-char ids, so a bare `"N"` won't match the uppercase key — use `"shift+n"` for `N`. See the worked example below.

To make `Escape` a no-op in the prompt, simply bind `denyAbort` to something else (e.g. `"shift+n"` for `N`). Escape then does nothing — abort is reached only via your chosen key.
## Configuration flags

| Flag | Default | Description |
|---|---|---|
| `--build` | `false` | Start in build mode (full access) |
| `--allow <rules>` | | Comma-separated allow rules (format: `permission: pattern`) |
| `--trust-external-paths` | `false` | Trust file paths outside the project root (skip external-path approval) |
**Example:** `pi --build --allow "edit: src/**, bash: npm *"`

## Commands

| Command | Description |
|---|---|
| `safetynet:plan` | Switch to plan mode |
| `safetynet:build` | Switch to build mode |
| `safetynet:rules` | Show current permission rules |
| `safetynet:auto` | Toggle auto-approve mode (route Asks through permissions model) |

## How it compares

This table reflects the gaps that motivated building pi-safetynet. I haven't rigorously audited every alternative — your experience may differ.

| Feature | pi-safetynet | Typical string-matching approaches |
|---|---|---|
| Bash command parsing | Full AST | `command.includes("rm")` |
| Pipeline subcommand extraction | ✅ Each cmd evaluated independently | Often a single opaque string |
| Redirect target tracking | ✅ `> file` → edit permission on file | Often not parsed separately |
| xargs inner command | ✅ Extracts and evaluates the inner command | May see only `xargs` |
| Heredoc write detection | ✅ Strips body, parses redirect | Heredoc content often invisible |
| `sed -i` vs `sed -n` distinction | ✅ In-place flags detected | Both may match `sed` |
| Interpreter one-liner detection | ✅ `python -c`, `node -e`, etc. | May see only the interpreter name |
| Plan mode bash write prevention | ✅ All edit-equivalent techniques blocked | Typically only edit/write tools disabled |
| Catastrophic command detection | Best-effort AST heuristics (peels sudo flags, timeout, xargs, quotes — see caveat) | Often substring matching |
| `[ -f /etc/passwd ]` as file read | ✅ Test operators tracked as reads | Often not tracked as file access |
| Hazardous file protection | ✅ `.env`, `.ssh`, credentials, etc. | ⚠️ Varies — sometimes config-driven |
| External path approval | ✅ Auto-detects paths outside project root | Project root awareness varies |
| Per-subcommand approval | ✅ Approve/deny individual pipeline stages | Often all-or-nothing for the whole command |
| Redirect-aware file permissions | ✅ `sort < .env` blocked as hazardous read | Redirect targets often not checked |

## Rule system

pi-safetynet uses a layered rule system (last match wins):

1. **Baseline** — Built-in rules shipped with pi-safetynet (read-only commands auto-approved, writes asked, etc.)
2. **Global** — User-defined rules from `~/.config/pi-safetynet/config.json` (see below)
3. **Persisted** — User-approved rules saved to `.pi/extensions/safetynet/approvals.json`
4. **Flag** — Rules from the `--allow` CLI flag (session-scoped, not persisted)
5. **Session** — Rules added interactively during this session
5. **Temporary** — Turn-limited rules

### Global config

You can define rules that apply across all projects via the global config file at `~/.config/pi-safetynet/config.json`. This is useful for commands you always want to allow (or deny), regardless of which project you're working in.

```json
{
  "rules": [
    { "permission": "bash", "pattern": "npm test", "action": "allow", "modes": ["build", "plan"] },
    { "permission": "bash", "pattern": "cargo test", "action": "allow", "modes": ["build", "plan"] },
    { "permission": "bash", "pattern": "npm publish *", "action": "deny", "modes": ["build", "plan"] }
  ],
  "subagents": ["subagent_run"]
}
```

#### `subagents` (deprecated)

Superseded by packaging: the background subagent tools now live in their own pi package,
**pi-submarine**. To turn them off, disable the pi-submarine entry in `pi config` (each package entry
is its own row) or don't install it. `"subagents": []` in this config file is still honored for one
release — tools suppressed, one deprecation notice at startup — and the key will be removed after.

##### Async two-way subagents (pi-submarine)

`subagent_run` returns a job id immediately and keeps the subagent alive across turns. The parent keeps talking while it works and is woken when the child reports or goes idle. Companion tools: `subagent_send` (message the child), `subagent_status` (bounded state view — never the child's transcript; also returns any reports not yet delivered, so findings are recoverable if a push is missed), `subagent_bash_output` (tail the child's current/most-recent bash command), `subagent_close` (end it). Children may call `report_to_parent` to send findings upward; `urgent: true` wakes the parent immediately. Children are killed on the next user message sent under a different mode. Up to 8 live jobs; the footer shows how many are running/idle. A child idle with pending watches reads `[waiting]` and does not wake the parent; a segment cut by the 300s cap reads `aborted at Ns while running: <cmd>` (never plain idle) and carries a report.

**Watches — waiting is infrastructure, not a sleeping agent** (pi-submarine). `subagent_watch` (parent) and `watch_for` (child) register a watch on pid-exit, a file pattern, a deadline, and/or a heartbeat cadence (default 30min, floor 60s, 24h lifetime). Nothing sleeps: kernel-level polling fires an event that wakes the parent or resumes the owning child (a child with pending watches parks quietly instead of burning turns). Each event carries the last log line and a timestamp; full output is a pull away (`subagent_watch tail`, or just read the log). `subagent_watch run` also launches the command itself detached (`setsid`-style, HUP-proof) so it survives pi exiting; records persist to a JSON store and are re-adopted at the next session start, where events that fired while pi was down surface immediately with a verdict (`finished` vs `killed`, via the captured exit artifact). Watches die with their owner (job close, mode kill); restart-orphaned child watches are inherited by the parent.

#### `keybindings`

Customizes the prompt's single-key deny actions. Both fields are optional.

- **`denyAbort`** — key to deny-and-abort (ends the turn). Default `"escape"`.
- **`denyContinue`** — key to deny-and-continue (non-aborting; model keeps its turn and sees the reason). No default (opt-in).

See [Prompt keybindings](#prompt-keybindings) for the key-id format. A common ask is to make `Escape` a no-op and use `n`/`N` instead — here's the exact config for that:

```json
{
  "keybindings": {
    "denyContinue": "n",
    "denyAbort": "shift+n"
  }
}
```

With this, `n` denies and continues, `N` (shift+n) denies and aborts, and `Escape` does nothing in the prompt.

#### `autoDeny`

Controls what happens when a call is denied automatically — either by a `deny` rule, a read-only/mode write denial, or in headless mode when an `ask` rule can't show a prompt:

- **`maxStrikes`** — strikes per turn (per scope) allowed before the turn aborts. Every strike sends the denial reason to the model as a non-aborting nudge (it also appears as the blocked tool's error result), followed by a short corrective instruction for that denial source so the model can self-correct instead of retrying or working around it; the strike that exhausts the budget also renders a visible transcript entry and ends the turn. Default `3`. Hazardous/sensitive-file denials are exempt — they never abort and never count (see [Hazardous file protection](#hazardous-file-protection)).
- **`continue`** — when `true`, the deny blocks the call WITHOUT ever aborting the turn, no matter how many strikes accumulate: the model sees the reason as the tool's error result and may keep reacting. Default `false` (abort once `maxStrikes` is reached).
- **`reason`** — a reason string surfaced to the model on auto-deny (e.g. `"Project policy: no network access"`). A per-rule `reason` field still takes precedence when present (more specific).

```json
{
  "autoDeny": {
    "maxStrikes": 3,
    "continue": false,
    "reason": "Denied by project policy"
  }
}
```

Read-only mode is the common case: a `ro`/`plan` session denies bash commands that write (redirects, heredocs, `sed -i`, …) and the disabled `edit`/`write` tools outright. The session scratch space (see [Session scratch space](#session-scratch-space)) is the exception — writes there are permitted in every mode. With the default `maxStrikes`, the first two attempts are non-aborting nudges only — the turn survives, so the model can propose a read-only alternative or ask you to switch modes — and the third ends the turn.

#### `toggleModeKey`

Remaps the global plan↔build toggle shortcut. Default `"ctrl+\\"`.

```json
{ "toggleModeKey": "ctrl+b" }
```


Each rule has:

- **`permission`** — `bash`, `edit`, `read`, or `*` (matches any)
- **`pattern`** — For `bash`/`*`: a command pattern where `*` is a wildcard (e.g. `npm *`). For `edit`/`read`: a [picomatch](https://github.com/micromatch/picomatch) glob pattern (e.g. `src/**/*.ts`).
- **`action`** — `allow`, `deny`, or `ask`
- **`modes`** — Which profiles the rule applies to: `["build"]`, `["plan"]`, or `["build", "plan"]`
- **`reason`** *(optional)* — A human-readable explanation included in the denial message when a `deny` rule blocks an action

#### Denylist-style rules

Because the rule system uses last-match-wins ordering, you can create denylist patterns: place a broad `allow` rule first, then `deny` (or `ask`) rules for specific exceptions. This works in the global config, project rules, and session rules alike.

For example, to allow all `npm` subcommands but deny `npm publish`:

```json
{
  "rules": [
    { "permission": "bash", "pattern": "npm *", "action": "allow", "modes": ["build", "plan"] },
    { "permission": "bash", "pattern": "npm publish *", "action": "deny", "modes": ["build", "plan"], "reason": "Publishing to npm should be done intentionally" }
}
```

Or to allow all `git` subcommands but require approval for force pushes:

```json
{
  "rules": [
    { "permission": "bash", "pattern": "git *", "action": "allow", "modes": ["build"] },
    { "permission": "bash", "pattern": "git push --force *", "action": "ask", "modes": ["build"] },
    { "permission": "bash", "pattern": "git push -f *", "action": "ask", "modes": ["build"] }
  ]
}
```

For file edits, you could auto-approve editing source files but always ask about migrations:

```json
{
  "rules": [
    { "permission": "edit", "pattern": "src/**", "action": "allow", "modes": ["build"] },
    { "permission": "edit", "pattern": "**/migrations/**", "action": "ask", "modes": ["build"] }
  ]
}
```

You can also add global rules through the approval prompt by selecting **Global** as the duration.

Rules support both profile modes, so a rule can be scoped to build mode only and remain invisible to plan mode.

## License

This project is licensed under the Mutualist License v1.2.  
See the [LICENSE.md](LICENSE.md) file for the full text.

### Mutualist License summary

**Permissions**

- ✅ Commercial use
- ✅ Private / internal use
- ✅ Modification
- ✅ Distribution (source and binaries)
- ✅ Network / SaaS use
- ✅ Patent use (from contributors, as described in the license)

**Conditions**

- ❗ Keep copyright and license notices
- ❗ Give appropriate credit (see "Credit" in the license)
- ❗ Share source for modified versions you distribute
- ❗ Share source for modified versions you let others use over a network
- ❗ License your changes under the Mutualist License too (same license)
- ❗ Don't add technical measures (like DRM) that stop users from exercising their rights
- ❗ Patent peace: you lose patent rights under this license if you start a patent attack over this software

**Limitations**

- ❌ No liability
- ❌ No warranty
- ❌ No trademark rights
- ❌ No implied endorsement
