/**
 * gate-liveness.ts — notice when the harness has detached a gating prompt.
 *
 * A permission prompt is rendered as an overlay, and the overlay handle is the
 * sensor: `OverlayHandle.getBounds()` returns undefined as soon as the entry
 * leaves the overlay stack. That happens when pi pops it wholesale —
 * `resetExtensionUI` on a session switch or `/reload`, or another overlay's
 * `close()` (which pops the topmost entry rather than its own).
 *
 * Crucially this is NOT a render-liveness check. `entry.bounds` holds its last
 * value while an overlay is mounted but idle, so a prompt that is simply
 * waiting on the user is never mistaken for a lost one — only a real
 * detachment reports missing bounds.
 *
 * A detached gate is indistinguishable from "not answered yet" to whoever is
 * awaiting it, and pi awaits extension `tool_call` handlers with no timeout, so
 * the gate has to resolve itself. Denying is the only safe resolution: the tool
 * call is refused and the model keeps its turn.
 *
 * omp needs none of this: it bounds extension handlers at 30s fail-closed, so a
 * stranded gate there fails closed instead of parking the session.
 */

export interface BoundsProbe {
  getBounds(): { height: number } | undefined;
}

export interface GateLivenessOptions {
  /** Wait this long before the first check — one render must land first, and
   *  bounds are undefined until then. */
  graceMs?: number;
  /** Gap between checks. */
  intervalMs?: number;
  /** Consecutive missing-bounds readings that mean the gate is gone. */
  misses?: number;
}

/**
 * Watch `probe` and call `onLost` at most once when its bounds have been
 * missing for `misses` consecutive checks past the grace period. Returns an
 * idempotent stop function; call it when the gate settles normally.
 */
export function watchGateLiveness(
  probe: BoundsProbe,
  onLost: () => void,
  opts: GateLivenessOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 1_000;
  const requiredMisses = opts.misses ?? 2;
  let misses = 0;
  let lost = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (grace !== undefined) clearTimeout(grace);
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const start = (): void => {
    timer = setInterval(() => {
      if (lost) return;
      if (probe.getBounds() !== undefined) {
        misses = 0;
        return;
      }
      if (++misses < requiredMisses) return;
      lost = true;
      stop();
      onLost();
    }, intervalMs);
    // A liveness probe must never hold the process open.
    (timer as { unref?: () => void }).unref?.();
  };

  grace = setTimeout(start, opts.graceMs ?? 1_500);
  (grace as { unref?: () => void }).unref?.();

  return stop;
}
