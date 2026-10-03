# pi-safetynet Extension

## Commands

- `npm test` — Run all tests (uses Node.js built-in test runner, NOT vitest)
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run check` — Typecheck + test (run this before committing)

## Live tests (smoke-live.ts)

Real headless pi — minutes of wall time and provider tokens. Policy: run
`node --experimental-strip-types smoke-live.ts` (S1–S7) ONLY when touching the
pi-submarine / watches / subagent subsystem. Never pay that cost for unrelated
features. Subsystem extras are on demand only — `SMOKE_ONLY=extras` (X1
lifetime/extend, X2 silence detection) when touching those specific
mechanisms; `SMOKE_ONLY=S3,S7` filters for targeted re-proves.

When you add new commands to baseline, check if any tests used those commands and need to be updated to remaing meaningful.
