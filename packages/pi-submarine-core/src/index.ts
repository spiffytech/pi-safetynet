/**
 * pi-submarine-core — the runtime shared by pi-safetynet (reviewer sessions)
 * and pi-submarine (persistent two-way subagents).
 *
 * Everything here is pure or injected: this package holds no module state, so
 * every package importing it gets its own instance and nothing breaks. Live
 * things (mode, rules, prompts, approvals) cross package boundaries only via
 * the `SafetynetHost` contract in host-api.ts.
 */

export * from "./host-api.ts";
export * from "./paths.ts";
export * from "./report.ts";
export * from "./reporting.ts";
export * from "./watch.ts";
export * from "./usage.ts";
export * from "./child-ext.ts";
export * from "./session.ts";