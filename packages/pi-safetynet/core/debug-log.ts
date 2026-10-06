/**
 * debug-log.ts — file-routed diagnostics.
 *
 * An extension runs in-process with the TUI. Anything written to the terminal
 * from here (console.warn/error/log) interleaves with the renderer's frames
 * and corrupts the display. Diagnostics still need to land somewhere, so they
 * go to a file instead.
 *
 * Read with: tail -f ~/.cache/pi-safetynet/debug.log
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".cache", "pi-safetynet");
const LOG_PATH = join(DIR, "debug.log");

/** Truncate rather than rotate: this is a diagnostic breadcrumb, not an audit log. */
const MAX_BYTES = 1_000_000;

/** Append a diagnostic line to the safetynet debug log.
 *
 *  Never throws and never writes to the terminal — a failed log (unwritable
 *  dir, full disk, permissions) must not break the review path that called it.
 */
export function debugLog(message: string): void {
  try {
    mkdirSync(DIR, { recursive: true });
    try {
      if (statSync(LOG_PATH).size > MAX_BYTES) writeFileSync(LOG_PATH, "");
    } catch {
      // Missing file / stat race — the append below creates it.
    }
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Swallow: diagnostics must never be the reason a review fails.
  }
}

/** Append one JSONL review record to the review ledger.
 *
 *  `~/.cache/pi-safetynet/reviews.jsonl` — inputs decided, verdict, latency,
 *  token usage. Unlike `debug.log` this is append-only and never truncated:
 *  it is the dataset for the "would another methodology have decided
 *  differently?" question. Path is resolved lazily so tests can redirect HOME.
 *  Disabled wholesale by test-setup so unit runs never pollute the real ledger.
 */
let reviewLogEnabled = true;

export function setReviewLogEnabled(enabled: boolean): void {
  reviewLogEnabled = enabled;
}

export function reviewLog(record: Record<string, unknown>): void {
  if (!reviewLogEnabled) return;
  try {
    const dir = join(homedir(), ".cache", "pi-safetynet");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "reviews.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // Swallow: bookkeeping must never be the reason a review fails.
  }
}
