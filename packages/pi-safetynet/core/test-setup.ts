import { initBashParser } from "./bash-parser.ts";

// The bash parser is a one-time async WASM initialization, but parseCommand is
// synchronous.  Loading it here (via `node --import`) guarantees it is ready
// before any test file runs.
await initBashParser();
