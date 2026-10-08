/**
 * ui-arbiter.ts — single coordinator for interactive UI surfaces so they
 * never stomp on each other (plans/inferred-rules-design.md, arbiter section).
 *
 * Priority classes:
 *   - P0: gating prompts (permission prompts, hazardous nudges). They block
 *     a tool call, so they ALWAYS win immediately. Acquiring P0 preempts
 *     whatever is showing — a P1 defers (nothing it gates is blocked), and a
 *     displaced P0 resolves as a deny. Of two racing P0s the newer wins;
 *     priority ordering (parent before child) is not yet a policy.
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
  /** Force-dismiss the component. P1 defers/hides and must never abort the
   *  agent. P0 must resolve its pending gate — as a DENY, never an abort — so
   *  that an eviction or teardown can never strand the tool call awaiting it. */
  dismiss: () => void;
}

class UiArbiter {
  private current: ArbiterEntry | null = null;

  /** Returns true when the caller may show its UI now. Stores the caller's
   *  entry object itself — release(entry) matches by identity. */
  acquire(entry: ArbiterEntry): boolean {
    if (entry.priority === "p0") {
      // A P0 preempts whatever is showing: a P1 defers, and a displaced P0
      // resolves as a deny rather than being left stranded. The harness mounts
      // the new gate over the old one, so an un-dismissed old gate would await
      // forever. WHICH of two racing gates should win (parent vs child) is a
      // separate policy question — today the newer one does.
      const preempted = this.current;
      this.current = entry;
      preempted?.dismiss();
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
  /** Hand in the harness's `done` callback. */
  bind(done: (result: T) => void): void;
  /** Resolve the gate. Later calls — and any later dismiss — are no-ops. */
  finish(result: T): void;
}

export function createGateSettlement<T>(onDismissed: () => T): GateSettlement<T> {
  let resolve: ((result: T) => void) | null = null;
  let settled = false;
  const settle = (result: T): void => {
    if (settled) return;
    settled = true;
    resolve?.(result);
  };
  return {
    entry: { priority: "p0", dismiss: () => settle(onDismissed()) },
    bind(done) {
      resolve = done;
      // Dismissed between acquire and mount: resolve now rather than leave the
      // caller's await dangling.
      if (settled) done(onDismissed());
    },
    finish: settle,
  };
}

export const uiArbiter = new UiArbiter();
