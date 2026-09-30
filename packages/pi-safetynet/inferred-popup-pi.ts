/**
 * inferred-popup-pi.ts — pi wrapper for the shared inferred-review component.
 *
 * Same contract as the omp wrapper: rendered as an OVERLAY (outside the editor
 * container, so concurrent prompts/dialogs cannot silently evict it — see the
 * omp wrapper header for the eviction mechanism) and fire-and-forget (the
 * returned promise resolves when the popup starts, never when it closes).
 */
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProfileName } from "./core/types.ts";
import type { InferredEngine } from "./core/inferred/engine.ts";
import { InferredReviewComponent, type PopupKey } from "./core/inferred/popup-component.ts";
import { uiArbiter, type ArbiterEntry } from "./core/ui-arbiter.ts";

const keyMap: Record<PopupKey, KeyId> = {
  escape: Key.escape,
  up: Key.up,
  down: Key.down,
  left: Key.left,
  right: Key.right,
  enter: Key.enter,
};

class BusyStub implements Component {
  render(_width: number): string[] {
    return [];
  }
  invalidate(): void {}
  handleInput(_data: string): void {}
}

export type OpenInferredReviewResult = "opened" | "empty" | "busy" | "nohost";

export async function openInferredReview(
  ctx: ExtensionContext,
  engine: InferredEngine,
  opts: { modes?: ProfileName[]; onQueueChange?: (remaining: number) => void } = {},
): Promise<OpenInferredReviewResult> {
  if (!ctx.hasUI) return "nohost";
  if (engine.listProposals().length === 0) return "empty";
  if (uiArbiter.isShowing()) return "busy";

  const modes = opts.modes ?? ["build"];
  let settled = false;
  let done: ((result: null) => void) | null = null;
  let handle: { hide(): void } | null = null;
  let entry: ArbiterEntry;

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      handle?.hide();
    } catch {
      // overlay already gone
    }
    uiArbiter.release(entry);
    done?.(null);
  };
  entry = { priority: "p1", dismiss: finish };

  void ctx.ui
    .custom<null>(
      (tui, theme, _keybindings, d) => {
        done = d;
        if (!uiArbiter.acquire(entry)) {
          settled = true;
          d(null);
          return new BusyStub();
        }
        return new InferredReviewComponent(engine, {
          modes,
          isKey: (data, key) => matchesKey(data, keyMap[key]!),
          pump: () => tui.requestRender(),
          theme,
          ...(opts.onQueueChange ? { onQueueChange: opts.onQueueChange } : {}),
          finish,
        });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" },
        onHandle: (h) => {
          handle = h;
          if (settled) {
            try {
              h.hide();
            } catch {
              /* already gone */
            }
          }
        },
      },
    )
    .catch(() => {
      finish();
    });

  return "opened";
}