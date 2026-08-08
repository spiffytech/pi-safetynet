/**
 * herdr-state.ts — emit a "blocked on permission prompt" signal for herdr.
 *
 * herdr's pi integration (herdr-agent-state.ts, installed via
 * `herdr integration install pi`) listens on pi's shared extension event bus
 * for `herdr:blocked` events and reports state "blocked" to the herdr socket,
 * which flips the sidebar indicator. Without an emit, herdr keeps showing
 * pi as "working" while a safetynet permission prompt waits for input.
 *
 * The emitter is bound once per extension init from index.ts (bridge + root).
 * Module-level state is shared across in-process pipeline callers, so root and
 * subagent permission prompts both emit on the same (root) bus — exactly where
 * herdr's asset listens.
 *
 * Emitting is additive and safe: with no listener registered,
 * EventEmitter.emit is a no-op. reportBlocked is never allowed to throw.
 */

type BlockedEmitter = (active: boolean, label?: string) => void;

let emitBlocked: BlockedEmitter = () => {};

/** Bind the emit function (defaults to no-op). Call once per extension init. */
export function bindHerdrBlockedEmitter(fn?: BlockedEmitter): void {
  emitBlocked = fn ?? (() => {});
}

/** Report that safetynet is blocked waiting for a permission prompt (active)
 *  or that the blocking span ended (active=false). */
export function reportBlocked(active: boolean, label?: string): void {
  try {
    emitBlocked(active, label);
  } catch {
    // Never let a downstream listener failure break the permission pipeline.
  }
}
