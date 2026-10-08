/**
 * ui-arbiter.ts — single coordinator for interactive UI surfaces so they
 * never stomp on each other (plans/inferred-rules-design.md, arbiter section).
 *
 * Priority classes:
 *   - P0: gating prompts (permission prompts, hazardous nudges). They block
 *     a tool call, so they win immediately. Acquiring P0 preempts whatever is
 *     showing — a P1 defers (nothing it gates is blocked) and a displaced P0
 *     resolves as a deny. Parent gates outrank child gates: a child may not
 *     take the screen from a parent, which would deny the parent without the
 *     user ever seeing its prompt, while a parent preempts a child's. Within
 *     one rank the newer gate wins.
 *   - P1: non-blocking interactive surfaces (inferred-rule review popup).
 *     Only one P1 shows at a time; a P1 arriving while anything is showing
 *     is denied (caller skips — the queue + badge remain).
 *   - P2: passive (widgets, toasts, status). Never coordinated.
 *
 * Preempt contract: P1 components must survive dismiss without losing state
 * — for the proposal popup the state IS the persistent queue, so dismiss =
 * defer. Text-draft components (future interactive reviewer) will persist
 * their draft in serialize()/restore() implementations before dismissing.
 *
 * Process-global singleton: both frontends and bridged subagent prompts in
 * one process share it, which is the point.
 */

type Priority = "p0" | "p1";

export interface ArbiterEntry {
  priority: Priority;
  /** Who is asking. "parent" is the session the user is driving; "child" is a
   *  subagent. A child gate may not displace a parent's. Defaults to
   *  "parent". */
  owner?: "parent" | "child";
  /** Force-dismiss the component. P1 defers/hides and must never abort the
   *  agent. P0 must resolve its pending gate — as a DENY, never an abort — so
   *  that an eviction or teardown can never strand the tool call awaiting it. */
  dismiss: () => void;
}

/** Parent gates outrank child gates. */
function p0Rank(entry: ArbiterEntry): number {
  return entry.owner === "child" ? 0 : 1;
}

class UiArbiter {
  private current: ArbiterEntry | null = null;

  /** Returns true when the caller may show its UI now. Stores the caller's
   *  entry object itself — release(entry) matches by identity. */
  acquire(entry: ArbiterEntry): boolean {
    if (entry.priority === "p0") {
      const current = this.current;
      if (!current) {
        this.current = entry;
        return true;
      }
      if (current.priority === "p1") {
        // A gate preempts a non-blocking surface. A dismissed P1 defers — its
        // state is the persistent queue — so nothing is lost.
        this.current = entry;
        current.dismiss();
        return true;
      }
      // P0 vs P0. A child gate must not take the screen from a parent gate:
      // the parent would be denied without the user ever seeing its prompt.
      // Returning false lets the caller resolve itself as a deny and retry.
      if (p0Rank(entry) < p0Rank(current)) return false;
      // Same rank, or a parent arriving behind a child: the newer gate wins
      // and the displaced one resolves as a deny rather than awaiting forever.
      this.current = entry;
      current.dismiss();
      return true;
    }
    if (this.current) return false; // P1 while anything is showing
    this.current = entry;
    return true;
  }

  /** Release after the component's promise settles. Identity-guarded so a
   *  preempted P1 releasing late cannot clear a live P0. */
  release(entry: ArbiterEntry): void {
    if (this.current === entry) this.current = null;
  }

  isShowing(): boolean {
    return this.current !== null;
  }

  /** Priority of the surface currently showing, or null. Lets a caller tell a
   *  gate displacement (a displaced gate resolves as a deny) from a harmless
   *  P1 preemption. */
  currentPriority(): Priority | null {
    return this.current?.priority ?? null;
  }

  /** Last-resort cleanup when the UI is torn down wholesale (session switch,
   *  `/reload`): a stale entry must never be able to block every future
   *  surface. Dismisses whatever is showing. P1 defers (nothing it gates is
   *  blocked); P0 resolves as a deny. An unresolved gate is strictly worse
   *  than a denied one — pi awaits extension tool_call handlers with no
   *  timeout, so a stranded gate parks the session forever. */
  reset(): void {
    const current = this.current;
    this.current = null;
    current?.dismiss();
  }
}

/**
 * One-shot gate settlement shared by both permission prompts.
 *
 * A gating prompt resolves three ways: the user answers it, an abort signal
 * fires, or the arbiter dismisses it (eviction, session teardown). All three
 * must funnel through one settle, because the harness awaits the gate inside a
 * `tool_call` handler and pi awaits those handlers with no timeout — a gate
 * that never resolves parks the session forever with no prompt on screen.
 *
 * So `dismiss` resolves the gate as a DENY (the caller keeps its turn and gets
 * a denial to act on), and `bind` resolves immediately when the dismissal beat
 * the component mount.
 */
export interface GateSettlement<T> {
  /** Arbiter entry to acquire; its `dismiss` resolves the gate as a deny. */
  entry: ArbiterEntry;
  /** Resolves once the gate is answered by any path, including one that never
   *  tells the harness (see `lose`). Await this alongside the harness promise. */
  answered: Promise<T>;
  /** Hand in the harness's `done` callback. */
  bind(done: (result: T) => void): void;
  /** The user answered, or the harness asked for dismissal: resolve AND tell the
   *  harness, so it tears down its own surface. Later calls are no-ops. */
  finish(result: T): void;
  /** The harness surface is already gone: resolve WITHOUT telling the harness.
   *  pi's overlay `close()` calls `hideOverlay()`, which pops the TOPMOST
   *  overlay — for a gate that has already been removed that is somebody else's
   *  surface. Ignored before `bind`: a gate that never mounted cannot be lost. */
  lose(result: T): void;
}

export function createGateSettlement<T>(
  onDismissed: () => T,
  opts: { owner?: "parent" | "child" | undefined } = {},
): GateSettlement<T> {
  let resolveHarness: ((result: T) => void) | null = null;
  let resolveAnswered: ((result: T) => void) | null = null;
  let settled: { value: T } | null = null;
  const answered = new Promise<T>((resolve) => {
    resolveAnswered = resolve;
  });
  const settle = (result: T, tellHarness: boolean): void => {
    if (settled !== null) return;
    settled = { value: result };
    if (tellHarness) resolveHarness?.(result);
    resolveAnswered?.(result);
  };
  return {
    answered,
    entry: {
      priority: "p0",
      owner: opts.owner ?? "parent",
      dismiss: () => settle(onDismissed(), true),
    },
    bind(done) {
      resolveHarness = done;
      // Unreachable in practice — the harness calls the factory synchronously
      // right after acquire, and both `lose` and a sibling gate's `dismiss`
      // happen after mount. Kept so an already-answered gate can never wedge a
      // mount that has nowhere to report to.
      if (settled !== null) done(settled.value);
    },
    finish(result) {
      settle(result, true);
    },
    lose(result) {
      if (resolveHarness === null) return;
      settle(result, false);
    },
  };
}

export const uiArbiter = new UiArbiter();
