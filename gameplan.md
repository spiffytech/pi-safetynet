# spfy Implementation Gameplan

This document outlines the concrete steps for implementing the `spfy` extension based on the simplified `PLAN.md` and the pi-mono extension API examples.

## Context & Approach

- **Core Goal:** Implement a `plan`/`build` permission system using `@aliou/sh` for subcommand extraction and simple wildcard matching (`*` -> `.*`) for rule validation.
- **Reference Material:** We are using patterns from `plan-mode/index.ts` (for state persistence, UI updates, context injection) and `confirm-destructive.ts` / `permission-gate.ts` (for tool interception).
- **Simplification Key:** We explicitly *avoid* AST-based rule parsing. Rules are simple strings. The AST is only used to safely break apart the *executed* command into independent pieces before matching.

## Phase 1: Foundation & Types

1. **Create `types.ts`:**
   - Define `ProfileName` (`"plan" | "build"`).
   - Define `PermissionAction` (`"allow" | "deny" | "ask"`).
   - Define `Rule` interface (`permission`, `pattern`, `action`, `modes?`).
   - Define `Ruleset` (array of `Rule`).
   - Define the `switchProfile` tool parameters using `Typebox`.

2. **Create `permissions/baseline.json`:**
   - Implement the hardcoded allowlist for `plan` mode (cat, ls, grep, safe git commands, etc.) as defined in `PLAN.md`.

## Phase 2: AST Parsing & Security Guards

1. **Create `bash-parser.ts`:**
   - Import `@aliou/sh`.
   - Implement `getAllCommands(command: string): string[]`.
     - *Crucial detail:* Parse the command, traverse the AST, and extract all base commands (e.g., from `Pipeline`, `Logical`, `CommandSubstitution`).
     - *Simplification:* Stop traversing if we hit a `find` command with `-exec` or `-execdir`. Return the *entire* find command string as the extracted command.
   - Implement `hasFileRedirects(command: string): boolean`.
     - Check AST for redirect nodes (`>` or `>>`).
   - Implement `isCatastrophicCommand(command: string): boolean`.
     - Simple regex checks for `rm -rf /`, fork bombs, etc.
   - Implement `isHazardousFile(path: string): boolean`.
     - Checks for `.env`, `.ssh/`, etc.

2. **Create `project.ts`:**
   - Implement `findProjectRoot(cwd: string): string`.
     - Traverse up looking for `.pi/` directory.

## Phase 3: Rule Evaluation Engine

1. **Create `permissions/ruleset.ts`:**
   - Implement `globToRegex(pattern: string): RegExp`.
     - Convert `*` to `.*` and escape other regex chars for bash commands.
   - Implement `evaluatePermission(permission, target, profile, rules): { action: PermissionAction }`.
     - Use `Array.prototype.findLast()` so later rules override earlier ones.
     - For `read`/`edit`, use `picomatch` against the target path.
     - For `bash`, use the custom `globToRegex` against the target subcommand.
     - Handle the `modes` logic: if `modes` is undefined on an `allow` rule, it implies `["build"]`. If undefined on a `deny` rule, it implies all modes.

2. **Create `permissions/storage.ts`:**
   - Implement `PermissionStorage` class.
   - Manage the merge order: `baseline -> persisted -> session`.
   - Handle loading/saving `persisted` rules to `.pi/extensions/spfy/approvals.json` (relative to project root).

## Phase 4: UI & Prompts

1. **Create `prompts.ts`:**
   - Implement `showPermissionPrompt(ctx, { unapprovedCommands })`.
     - Display the list of unapproved subcommands.
     - Options: `[Allow once]`, `[Edit rules...]`, `[Deny]`.
   - Implement `showRulesEditor(ctx, unapprovedCommands): Promise<string | null>`.
     - Use `ctx.ui.editor()` pre-populated with the unapproved commands (one per line).
     - Explain the `*` wildcard usage in the prompt/header.
   - Implement `getPlanModeBlockMessage()`.

## Phase 5: Integration & Hooks (The Core)

1. **Create `index.ts` (Entry Point):**
   - Initialize `PermissionStorage`.
   - **`session_start` / `session_tree`:** Load persisted rules, reconstruct session rules from branch history (using `pi.appendEntry` or by scanning `customType: "spfy:permissions"` entries like `todo.ts` does). Set initial profile (default `build` unless `--plan` flag is passed).
   - **Register `/spfy:plan` and `/spfy:build` commands.**
   - **Register `switchProfile` tool.**
   - **`tool_call` interception:**
     - If `toolName === 'bash'`:
       - Check `isCatastrophicCommand`. Block if true.
       - Call `getAllCommands()` to get subcommands.
       - Evaluate each subcommand. If any are `deny`, block entirely (or prompt if `ask`).
       - If `profile === 'plan'`, strictly block any `deny` or `ask` with the `getPlanModeBlockMessage()`.
       - If `profile === 'build'` and we have `ask` results:
         - Loop: Show prompt -> If 'Edit rules', show editor -> Save rules to session -> Re-evaluate.
         - Break loop on 'Allow once' (return undefined to allow execution) or 'Deny' (return `{ block: true }`).
     - If `toolName === 'read'` or `'edit'`/`'write'`:
       - Check `isHazardousFile`.
       - Evaluate using `picomatch`.
       - Prompt loop similar to bash if action is `ask`.
   - **`before_agent_start`:**
     - Inject context message reminding the LLM of its current profile and available tools/permissions.
   - **`tool_result` (Plan-on-Error):**
     - If plan-on-error is enabled, append the `[SPFY_PLAN_ON_ERROR]` instruction to bash results.
   - **`context`:**
     - Filter out old profile context messages and plan-on-error markers from previous turns to keep the prompt clean.

## Phase 6: Refinement

- Ensure status bar updates reflect the current profile and plan-on-error state (`ctx.ui.setStatus()`).
- Add `/spfy:rules` command to dump current active ruleset for debugging.

## Immediate Next Steps (Upon switching to Build mode)

1. Scaffold the file structure.
2. Implement `types.ts` and `baseline.json`.
3. Implement `bash-parser.ts` (the trickiest part, needs careful `@aliou/sh` usage).
4. Build the core evaluation logic (`ruleset.ts`).
5. Wire it all up in `index.ts`.