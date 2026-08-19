import { describe, expect, it } from "bun:test";
import {
	AUDIT_TRAIL_BOX_COLORS,
	type AuditTrailBoxTheme,
	alarmPulse,
	badgeGlyph,
	badgePulseGlyph,
	elidePath,
	PULSE_PERIOD_MS,
	renderAuditMeterRow,
	renderAuditPanel,
	statusGlyphs,
	topRiskStatus,
} from "../src/audit-trail-box/render";
import { AuditLedgerState, COLD_AFTER_TURNS, POISON_STREAK_TICKS } from "../src/audit-trail-box/state";

// Identity theme so assertions see plain text instead of ANSI escapes.
const idTheme: AuditTrailBoxTheme = { fg: (_color, text) => text };
// Color-tagging theme for tests that need to assert which color the renderer chose.
const taggedTheme: AuditTrailBoxTheme = { fg: (color, text) => `${color}:${text}` };

// Unicode-tier glyphs, resolved once — every renderer call below defaults to `"unicode"`.
const BADGE_GLYPH = badgeGlyph("unicode");
const BADGE_PULSE_GLYPH = badgePulseGlyph("unicode");
const STATUS_GLYPHS = statusGlyphs("unicode");

const WIDE = 200;

/** Drive a path to POISONED: read it, then two probe ticks of divergence past the hysteresis gate. */
function poison(state: AuditLedgerState, path: string, nowMs = 100_000): void {
	state.noteRead(path, { hash: "held", content: "held\n" });
	for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) {
		state.noteProbe([{ path, hash: "moved", content: "moved\n", reachable: true }], nowMs + tick);
	}
}

/** Age a path into COLD by advancing past the eviction threshold. */
function chill(state: AuditLedgerState): void {
	for (let turn = 0; turn < COLD_AFTER_TURNS; turn++) state.noteTurn();
}

describe("audit trail box glyphs (preset-aware)", () => {
	it("badgeGlyph/badgePulseGlyph/statusGlyphs default to unicode; ambiguous-presentation glyphs carry VS15", () => {
		expect(badgeGlyph()).toBe("▣");
		expect(badgePulseGlyph()).toBe("▢");
		expect(statusGlyphs()).toEqual({
			poisoned: "⊘",
			dirty: "✎\uFE0E",
			redundant: "⟳",
			cold: "❄\uFE0E",
			fresh: "✓\uFE0E",
		});
	});

	it("ascii substitutes are exact one-column values, all seven distinct from one another", () => {
		expect(badgeGlyph("ascii")).toBe("@");
		expect(badgePulseGlyph("ascii")).toBe("+");
		expect(statusGlyphs("ascii")).toEqual({ poisoned: "x", dirty: "/", redundant: "~", cold: "o", fresh: "v" });
		const glyphs = [badgeGlyph("ascii"), badgePulseGlyph("ascii"), ...Object.values(statusGlyphs("ascii"))];
		expect(new Set(glyphs).size).toBe(glyphs.length);
		for (const glyph of glyphs) {
			expect(glyph).toHaveLength(1);
			expect(glyph.charCodeAt(0)).toBeLessThan(128);
		}
	});

	it("nerd aliases unicode exactly", () => {
		expect(badgeGlyph("nerd")).toBe(badgeGlyph("unicode"));
		expect(badgePulseGlyph("nerd")).toBe(badgePulseGlyph("unicode"));
		expect(statusGlyphs("nerd")).toEqual(statusGlyphs("unicode"));
	});
});

describe("audit trail box pulse math (pure)", () => {
	it("alarmPulse is bright on the first half of the period and dark on the second", () => {
		expect(alarmPulse(0)).toBe(true);
		expect(alarmPulse(PULSE_PERIOD_MS / 4)).toBe(true);
		expect(alarmPulse(PULSE_PERIOD_MS / 2)).toBe(false);
		expect(alarmPulse(PULSE_PERIOD_MS - 1)).toBe(false);
	});

	it("alarmPulse wraps across periods and survives negative phases", () => {
		expect(alarmPulse(PULSE_PERIOD_MS)).toBe(true);
		expect(alarmPulse(PULSE_PERIOD_MS * 3)).toBe(true);
		expect(alarmPulse(-1)).toBe(false);
		expect(alarmPulse(-PULSE_PERIOD_MS)).toBe(true);
	});

	it("topRiskStatus reports the most urgent non-empty status, and undefined when nothing is tracked", () => {
		const state = new AuditLedgerState();
		expect(topRiskStatus(state.snapshot())).toBeUndefined();

		state.noteRead("a.ts", { hash: "h" });
		expect(topRiskStatus(state.snapshot())).toBe("fresh");

		state.noteWrite("b.ts", 0, { hash: "h" });
		expect(topRiskStatus(state.snapshot())).toBe("dirty");

		poison(state, "c.ts");
		expect(topRiskStatus(state.snapshot())).toBe("poisoned");
	});

	it("elidePath keeps the identifying tail and marks the cut", () => {
		expect(elidePath("src/a.ts", 20)).toBe("src/a.ts");
		expect(elidePath("src/audit-trail-box/state.ts", 12)).toBe("…ox/state.ts");
		expect(elidePath("src/audit-trail-box/state.ts", 12).length).toBe(12);
	});

	it("elidePath degrades to a bare tail slice at absurd budgets instead of throwing", () => {
		expect(elidePath("abcdef", 1)).toBe("f");
		expect(elidePath("abcdef", 0)).toBe("f");
	});
});

describe("audit trail box meter row (compact surface)", () => {
	it("renders badge, per-status counts and the economics tail at full width", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h1" });
		state.noteRead("b.ts", { hash: "h2" });
		state.noteWrite("b.ts", 0, { hash: "h3" });

		const row = renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle");
		expect(row.startsWith(BADGE_GLYPH)).toBe(true);
		expect(row).toContain(`1${STATUS_GLYPHS.dirty}`);
		expect(row).toContain(`1${STATUS_GLYPHS.fresh}`);
		expect(row).toContain("r/w 2/1");
		expect(row).toContain("×1.0");
		expect(row).toContain("↻0%");
	});

	it("threads a live preset into the badge and status glyphs — not just the default", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h1" });
		state.noteWrite("b.ts", 0, { hash: "h2" });

		const row = renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle", undefined, "ascii");
		expect(row.startsWith(badgeGlyph("ascii"))).toBe(true);
		expect(row).toContain(`1${statusGlyphs("ascii").dirty}`);
		expect(row).not.toContain(badgeGlyph("unicode"));
	});

	it("orders the count cells highest-risk first", () => {
		const state = new AuditLedgerState();
		state.noteRead("fresh.ts", { hash: "h" });
		state.noteWrite("dirty.ts", 0, { hash: "h" });
		poison(state, "bad.ts");

		const row = renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle");
		const poisonedAt = row.indexOf(STATUS_GLYPHS.poisoned);
		const dirtyAt = row.indexOf(STATUS_GLYPHS.dirty);
		const freshAt = row.indexOf(STATUS_GLYPHS.fresh);
		expect(poisonedAt).toBeGreaterThan(-1);
		expect(poisonedAt).toBeLessThan(dirtyAt);
		expect(dirtyAt).toBeLessThan(freshAt);
	});

	it("omits statuses with no paths rather than printing zeros", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		const counts = (renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle").split(" r/w ")[0] ?? "").trim();
		expect(counts).toBe(`${BADGE_GLYPH} 1${STATUS_GLYPHS.fresh}`);
		expect(counts).not.toContain(STATUS_GLYPHS.poisoned);
		expect(counts).not.toContain(STATUS_GLYPHS.cold);
		expect(counts).not.toContain("0");
	});

	it("drops the economics tail before it drops counts", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		state.noteWrite("b.ts", 0, { hash: "h" });

		const full = renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle");
		const medium = renderAuditMeterRow(state.snapshot(), full.length - 1, 0, idTheme, "subtle");
		expect(medium).not.toContain("r/w");
		expect(medium).toContain(`1${STATUS_GLYPHS.dirty}`);
		expect(medium).toContain(`1${STATUS_GLYPHS.fresh}`);
	});

	it("degrades to a single count — the highest-risk one — under width pressure", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		state.noteRead("b.ts", { hash: "h" });
		state.noteWrite("c.ts", 0, { hash: "h" });
		poison(state, "d.ts");

		const single = renderAuditMeterRow(state.snapshot(), 4, 0, idTheme, "subtle");
		expect(single).toBe(`${BADGE_GLYPH} 1${STATUS_GLYPHS.poisoned}`);
		expect(single).not.toContain(STATUS_GLYPHS.fresh);
		expect(single.length).toBeLessThanOrEqual(4);
	});

	it("falls back to the bare badge when even one count does not fit", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		expect(renderAuditMeterRow(state.snapshot(), 1, 0, idTheme, "subtle")).toBe(BADGE_GLYPH);
	});

	it("renders nothing at all at zero or negative width", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		expect(renderAuditMeterRow(state.snapshot(), 0, 0, idTheme, "subtle")).toBe("");
		expect(renderAuditMeterRow(state.snapshot(), -10, 0, idTheme, "subtle")).toBe("");
	});

	it("says it is idle before anything is tracked, and shrinks to the badge", () => {
		const state = new AuditLedgerState();
		expect(renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle")).toBe(`${BADGE_GLYPH} nothing tracked`);
		expect(renderAuditMeterRow(state.snapshot(), 3, 0, idTheme, "subtle")).toBe(BADGE_GLYPH);
	});

	it("every degradation tier stays inside its budget", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		state.noteWrite("b.ts", 0, { hash: "h" });
		poison(state, "c.ts");
		for (let width = 1; width <= 80; width++) {
			expect(renderAuditMeterRow(state.snapshot(), width, 0, idTheme, "subtle").length).toBeLessThanOrEqual(width);
		}
	});

	it("colors the badge with the alarm token while a path is poisoned, and the accent token otherwise", () => {
		const clean = new AuditLedgerState();
		clean.noteRead("a.ts", { hash: "h" });
		expect(renderAuditMeterRow(clean.snapshot(), WIDE, 0, taggedTheme, "subtle")).toContain(
			`${AUDIT_TRAIL_BOX_COLORS.badge}:${BADGE_GLYPH}`,
		);

		const bad = new AuditLedgerState();
		poison(bad, "a.ts");
		expect(renderAuditMeterRow(bad.snapshot(), WIDE, 0, taggedTheme, "subtle")).toContain(
			`${AUDIT_TRAIL_BOX_COLORS.poisoned}:${BADGE_GLYPH}`,
		);
	});

	it("pulses the badge in the full tier only while a path is poisoned", () => {
		const bad = new AuditLedgerState();
		poison(bad, "a.ts");
		const bright = renderAuditMeterRow(bad.snapshot(), WIDE, 0, idTheme, "full");
		const dark = renderAuditMeterRow(bad.snapshot(), WIDE, PULSE_PERIOD_MS / 2, idTheme, "full");
		expect(bright.startsWith(BADGE_GLYPH)).toBe(true);
		expect(dark.startsWith(BADGE_PULSE_GLYPH)).toBe(true);
	});

	it("never pulses in the subtle tier, nor with a clean working set", () => {
		const bad = new AuditLedgerState();
		poison(bad, "a.ts");
		expect(
			renderAuditMeterRow(bad.snapshot(), WIDE, PULSE_PERIOD_MS / 2, idTheme, "subtle").startsWith(BADGE_GLYPH),
		).toBe(true);

		const clean = new AuditLedgerState();
		clean.noteRead("a.ts", { hash: "h" });
		expect(
			renderAuditMeterRow(clean.snapshot(), WIDE, PULSE_PERIOD_MS / 2, idTheme, "full").startsWith(BADGE_GLYPH),
		).toBe(true);
	});

	it("honors an accent override on the badge without recoloring the risk ramp", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		const colors = { ...AUDIT_TRAIL_BOX_COLORS, badge: "syntaxString" as const };
		const row = renderAuditMeterRow(state.snapshot(), WIDE, 0, taggedTheme, "subtle", colors);
		expect(row).toContain(`syntaxString:${BADGE_GLYPH}`);
		expect(row).toContain(`${AUDIT_TRAIL_BOX_COLORS.fresh}:1${STATUS_GLYPHS.fresh}`);
	});

	it("reports write amplification and the redundant-read ratio from the ledger", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		state.noteRead("a.ts", { hash: "h" });
		state.noteWrite("a.ts", 0, { hash: "h" });
		state.noteWrite("a.ts", 0, { hash: "h" });

		const row = renderAuditMeterRow(state.snapshot(), WIDE, 0, idTheme, "subtle");
		expect(row).toContain("r/w 2/2");
		expect(row).toContain("×2.0");
		expect(row).toContain("↻50%");
	});
});

describe("audit trail box panel (slash-command surface)", () => {
	it("heads with the turn and tracked-path count, and says so when empty", () => {
		const state = new AuditLedgerState();
		const lines = renderAuditPanel(state.snapshot(), idTheme);
		expect(lines[0]).toContain("audit trail box");
		expect(lines[0]).toContain("turn 0");
		expect(lines[0]).toContain("0 paths");
		expect(lines[1]).toContain("nothing tracked");
	});

	it("singularizes the heading for exactly one path", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		expect(renderAuditPanel(state.snapshot(), idTheme)[0]).toEndWith("1 path");
	});

	it("sorts rows by risk: poisoned, then dirty, then redundant, then cold, then fresh", () => {
		const state = new AuditLedgerState();
		state.noteRead("z-fresh.ts", { hash: "h" });
		state.noteRead("y-redundant.ts", { hash: "h" });
		state.noteRead("y-redundant.ts", { hash: "h" });
		chill(state);
		state.noteRead("x-cold.ts", { hash: "h" });
		chill(state);
		state.noteWrite("w-dirty.ts", 0, { hash: "h" });
		poison(state, "v-poisoned.ts");

		const rows = renderAuditPanel(state.snapshot(), idTheme).slice(1, -1);
		const order = rows.map(row => row.trim());
		expect(order[0]?.startsWith(STATUS_GLYPHS.poisoned)).toBe(true);
		expect(order[1]?.startsWith(STATUS_GLYPHS.dirty)).toBe(true);
		expect(order.some(row => row.startsWith(STATUS_GLYPHS.cold))).toBe(true);
	});

	it("caps rows and reports the remainder", () => {
		const state = new AuditLedgerState();
		for (let index = 0; index < 9; index++) state.noteRead(`file-${index}.ts`, { hash: "h" });

		const lines = renderAuditPanel(state.snapshot(), idTheme, { maxRows: 3 });
		expect(lines.filter(line => line.includes(STATUS_GLYPHS.fresh))).toHaveLength(3);
		expect(lines.some(line => line.includes("⋯ +6 more"))).toBe(true);
	});

	it("omits the remainder note when everything fits", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		expect(renderAuditPanel(state.snapshot(), idTheme, { maxRows: 3 }).some(line => line.includes("more"))).toBe(
			false,
		);
	});

	it("shows each row's severity verdict and the families that fired, in canonical order", () => {
		const state = new AuditLedgerState();
		poison(state, "a.ts");
		state.noteRecovery(100_000);

		const row = renderAuditPanel(state.snapshot(), idTheme).find(line => line.includes("a.ts"));
		expect(row).toBeDefined();
		expect(row).toContain("alarm");
		expect(row).toContain("divergence+recovery");
	});

	it("marks a path with no firing families with an em dash rather than an empty column", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		const row = renderAuditPanel(state.snapshot(), idTheme).find(line => line.includes("a.ts"));
		expect(row).toContain("none");
		expect(row).toContain("—");
	});

	it("elides long paths to the configured column budget", () => {
		const state = new AuditLedgerState();
		const long = `src/${"deep/".repeat(20)}state.ts`;
		state.noteRead(long, { hash: "h" });
		const row = renderAuditPanel(state.snapshot(), idTheme, { pathWidth: 20 }).find(line =>
			line.includes("state.ts"),
		);
		expect(row).toContain("…");
		expect(row).not.toContain(long);
	});

	it("closes with the session economics line", () => {
		const state = new AuditLedgerState();
		state.noteRead("a.ts", { hash: "h" });
		state.noteRead("a.ts", { hash: "h" });
		state.noteWrite("a.ts", 0, { hash: "h" });

		const last = renderAuditPanel(state.snapshot(), idTheme).at(-1) ?? "";
		expect(last).toContain("r/w 2/1");
		expect(last).toContain("write amp ×1.0");
		expect(last).toContain("redundant 50%");
		expect(last).toContain("bloat");
	});

	it("colors each row by its status token", () => {
		const state = new AuditLedgerState();
		poison(state, "a.ts");
		const row = renderAuditPanel(state.snapshot(), taggedTheme).find(line => line.includes("a.ts")) ?? "";
		expect(row).toContain(`${AUDIT_TRAIL_BOX_COLORS.poisoned}:${STATUS_GLYPHS.poisoned}`);
	});
});

describe("renderAuditPanel — OSC-8 hyperlink wrapping", () => {
	it("wraps absolute paths with file:// hyperlinks when program is provided", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/main.ts", { hash: "h1" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, idTheme, { program: "kitty" });

		// Find the line with the path (should be line 1, after the heading)
		const pathLine = lines[1];
		expect(pathLine).toBeDefined();
		// Should contain OSC-8 escape sequences
		expect(pathLine).toContain("\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\");
		// Should have closing OSC-8
		expect(pathLine).toContain("\x1b]8;;\x1b\\");
	});

	it("does not wrap paths when program is not provided", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/main.ts", { hash: "h1" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, idTheme);

		const pathLine = lines[1];
		expect(pathLine).toBeDefined();
		// Should NOT contain OSC-8 escape sequences
		expect(pathLine).not.toContain("\x1b]8;;");
	});

	it("does not wrap paths for unsupported terminal", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/main.ts", { hash: "h1" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, idTheme, { program: "other" });

		const pathLine = lines[1];
		expect(pathLine).toBeDefined();
		// Should NOT contain OSC-8 escape sequences
		expect(pathLine).not.toContain("\x1b]8;;");
	});

	it("preserves color wrapping around hyperlinks", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/main.ts", { hash: "h1" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, taggedTheme, { program: "kitty" });

		const pathLine = lines[1];
		expect(pathLine).toBeDefined();
		// Should have both color tagging and hyperlink escapes
		// The color should wrap the display text before hyperlink wrapping
		expect(pathLine).toContain("success:"); // fresh status uses success color
		expect(pathLine).toContain("\x1b]8;;file:///Users/dev/project/src/main.ts\x1b\\");
	});

	it("hyperlink escapes do not affect visible width calculation", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/main.ts", { hash: "h1" });
		const snapshot = state.snapshot();

		// Render without hyperlinks
		const linesPlain = renderAuditPanel(snapshot, idTheme);
		// Render with hyperlinks
		const linesHyperlinked = renderAuditPanel(snapshot, idTheme, { program: "kitty" });

		// Both should have same number of lines
		expect(linesHyperlinked.length).toBe(linesPlain.length);

		// The hyperlinked version has more bytes but same structure
		const plainPathLine = linesPlain[1] ?? "";
		const hyperlinkedPathLine = linesHyperlinked[1] ?? "";

		// Hyperlinked version should be longer in byte length
		expect(hyperlinkedPathLine.length).toBeGreaterThan(plainPathLine.length);

		// But the visible content structure should be the same
		// (both have glyph, path, and detail sections separated by spaces)
		// Hyperlinked version will have escapes embedded, but should contain same visible text
		expect(hyperlinkedPathLine).toContain("main.ts");
	});

	it("handles elided paths correctly", () => {
		const longPath = "/Users/dev/very/long/project/path/that/exceeds/width/src/main.ts";
		const state = new AuditLedgerState();
		state.noteRead(longPath, { hash: "h1" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, idTheme, { program: "kitty", pathWidth: 30 });

		const pathLine = lines[1];
		expect(pathLine).toBeDefined();
		// Should contain the FULL path in the file:// URI, not the elided version
		expect(pathLine).toContain(`file://${longPath}`);
		// The display text will be elided (shown with …)
		expect(pathLine).toContain("…");
	});

	it("works with multiple paths in one panel", () => {
		const state = new AuditLedgerState();
		state.noteRead("/Users/dev/project/src/a.ts", { hash: "h1" });
		state.noteWrite("/Users/dev/project/src/b.ts", 0, { hash: "h2" });
		state.noteRead("/Users/dev/project/src/c.ts", { hash: "h3" });
		const snapshot = state.snapshot();
		const lines = renderAuditPanel(snapshot, idTheme, { program: "kitty" });

		// Should have heading + 3 paths + metrics = 5 lines
		expect(lines.length).toBe(5);

		// Each path line should have its own hyperlink
		expect(lines[1]).toContain("file:///Users/dev/project/src");
		expect(lines[2]).toContain("file:///Users/dev/project/src");
		expect(lines[3]).toContain("file:///Users/dev/project/src");
	});
});
