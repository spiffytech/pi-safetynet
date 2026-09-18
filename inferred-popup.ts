/**
 * inferred-popup.ts — omp wrapper for the shared inferred-review component.
 *
 * Rendered as an OVERLAY, deliberately: this harness's `ctx.ui.custom()` mounts
 * editor-replacement components via `editorContainer.clear()`, and `Box.clear()`
 * does not dispose evicted children — so any concurrent surface (a slash
 * command, a selector, another extension's dialog) silently orphaned the popup,
 * stranding its promise and leaking the UI-arbiter entry. Overlays live outside
 * the editor container (`showOverlay` + handle) and take focus themselves, so
 * that entire failure class is gone.
 *
 * Also fire-and-forget: this promise resolves once the popup is STARTED, never
 * when it closes, so no caller can hang on a popup.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { Key, matchesKey, type KeyId } from "@oh-my-pi/pi-tui";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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

/** Safety-net placeholder if the arbiter is taken between the pre-check and
 *  the factory. Renders nothing; resolves immediately. */
class BusyStub implements Component {
	render(): readonly string[] {
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
	// Never open while another of our surfaces shows; foreign surfaces cannot
	// evict an overlay, but this keeps our own prompts strictly ordered.
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

	// Fire-and-forget: resolves when the overlay is mounted (or refused), not
	// when the user is done. Callers that want the review can await — it will
	// never block on user input.
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
			// Aborted before/after mount — make sure the entry cannot leak.
			finish();
		});

	return "opened";
}