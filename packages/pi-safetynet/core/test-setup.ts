import { initBashParser } from "./bash-parser.ts";
import { setReviewLogEnabled } from "./debug-log.ts";

// The bash parser is a one-time async WASM initialization, but parseCommand is
// synchronous.  Loading it here (via `node --import`) guarantees it is ready
// before any test file runs.
await initBashParser();

// Unit runs must never write review records into the real
// ~/.cache/pi-safetynet/reviews.jsonl — that ledger is production data.
setReviewLogEnabled(false);
