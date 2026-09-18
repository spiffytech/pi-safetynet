/**
 * ui-arbiter.ts — single coordinator for interactive UI surfaces so they
 * never stomp on each other (plans/inferred-rules-design.md, arbiter section).
 *
 * Priority classes:
 *   - P0: gating prompts (permission prompts, hazardous nudges). They block
 *     a tool call, so they ALWAYS win immediately. Acquiring P0 preempts a
 *     showing P1 by dismissing it (P1 dismiss = defer, never abort — nothing
 *     P1 gates is blocked).
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
  /** Force-dismiss the component (resolve its done()). Must never abort the
   *  agent for P1; P0 dismissals are not requested by the arbiter. */
  dismiss: () => void;
}

class UiArbiter {
  private current: ArbiterEntry | null = null;

  /** Returns true when the caller may show its UI now. Stores the caller's
   *  entry object itself — release(entry) matches by identity. */
  acquire(entry: ArbiterEntry): boolean {
    if (entry.priority === "p0") {
      if (this.current?.priority === "p1") {
        const preempted = this.current;
        this.current = null;
        preempted.dismiss(); // P1 defers; its release() is an identity no-op
      }
      this.current = entry;
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

  /** Last-resort cleanup when the UI is torn down wholesale (session switch):
   *  a stale entry must never be able to block every future surface. Dismisses
   *  a showing P1 (P1 dismiss = defer/hide, never abort) but leaves a P0
   *  gating prompt alone — dismissing that would deny a pending tool call. */
  reset(): void {
    const current = this.current;
    this.current = null;
    if (current?.priority === "p1") current.dismiss();
  }
}

export const uiArbiter = new UiArbiter();
