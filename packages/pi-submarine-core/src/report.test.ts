import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { capText, capReportSummary, capBashTail, REPORT_SUMMARY_MAX, BASH_TAIL_MAX } from "./report.ts";

describe("report size caps", () => {
	it("leaves text at or under the cap untouched", () => {
		assert.equal(capText("hi", 10), "hi");
		assert.equal(capText("x".repeat(10), 10), "x".repeat(10));
	});

	it("truncates over-cap text with an explicit marker", () => {
		const out = capText("x".repeat(20), 10);
		assert.ok(out.startsWith("x".repeat(10)));
		assert.match(out, /truncated/);
	});

	it("applies the summary and bash-tail caps", () => {
		const summary = capReportSummary("y".repeat(REPORT_SUMMARY_MAX + 5));
		assert.ok(summary.startsWith("y".repeat(REPORT_SUMMARY_MAX)));
		assert.match(summary, /truncated/);
		const tail = capBashTail("z".repeat(BASH_TAIL_MAX + 5));
		assert.ok(tail.startsWith("z".repeat(BASH_TAIL_MAX)));
		assert.match(tail, /truncated/);
	});

	it("returns empty for undefined input", () => {
		assert.equal(capText(undefined, 10), "");
		assert.equal(capReportSummary(undefined), "");
		assert.equal(capBashTail(undefined), "");
	});
});
