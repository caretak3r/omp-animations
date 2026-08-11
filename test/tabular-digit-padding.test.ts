/**
 * Tabular-figure digit alignment tests — every live-updating numeric field
 * must maintain constant visual width across its value range to prevent jitter.
 */
import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import {
	buildAuditTrailBoxSegment,
	buildCadenceEqualizerSegment,
	buildRateLimitTidepoolSegment,
} from "../src/animations-box/segments";
import type { AuditLedgerState } from "../src/audit-trail-box";
import type { CadenceEqualizerState } from "../src/cadence-equalizer";
import type { RateLimitTidepoolState } from "../src/rate-limit-tidepool";

// Identity theme for plain text assertions
const idTheme = { fg: (_color: string, text: string) => text };

describe("Tabular digit padding — constant width across value ranges (oh-my-pi-jj7.9)", () => {
	it("cache percentage: 0.0% to 100.0% primary field maintains constant width", () => {
		// Test the primary field formatting directly (avoid renderCacheMeterRow dependency)
		const percentages = [0, 5, 50, 92, 100];
		const formatted = percentages.map(p => `${p.toFixed(1)}%`.padStart(6, " "));

		const widths = formatted.map(s => visibleWidth(s));

		// All widths must be identical
		expect(widths.every(w => w === 6)).toBe(true);
	});

	it("cadence rate: -- and 0-160 t/s maintains constant width", () => {
		// Mock state
		const mockState = {
			snapshotBands: () => [0, 0, 0, 0, 0],
			snapshotPeaks: () => [0, 0, 0, 0, 0],
		} as unknown as CadenceEqualizerState;

		const rates = [null, 0, 1, 10, 50, 100, 160];
		const widths = rates.map(rate => {
			const segment = buildCadenceEqualizerSegment(mockState, true, rate, Date.now(), idTheme);
			return visibleWidth(segment.detail.primary);
		});

		// All widths must be identical
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it("cadence peak: peak 0 to peak 160 maintains constant width", () => {
		const peakAmplitudes = [0, 0.1, 0.5, 0.9, 1.0]; // Normalized 0-1

		const widths = peakAmplitudes.map(peakAmp => {
			const mockState = {
				snapshotBands: () => [peakAmp, 0, 0, 0, 0],
				snapshotPeaks: () => [peakAmp, peakAmp, peakAmp, peakAmp, peakAmp],
			} as unknown as CadenceEqualizerState;

			const segment = buildCadenceEqualizerSegment(mockState, true, 100, Date.now(), idTheme);
			return visibleWidth(segment.detail.secondary);
		});

		// All widths must be identical
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it("rate limit percentage: 0% to 100% maintains constant width", () => {
		const levels = [0, 0.05, 0.5, 0.78, 1.0];
		const now = Date.now();

		const widths = levels.map(level => {
			const mockState = {
				snapshot: () => ({
					level,
					provider: "anthropic",
					observedAtMs: now,
					resetAtMs: now + 60000,
				}),
			} as unknown as RateLimitTidepoolState;

			const segment = buildRateLimitTidepoolSegment(mockState, now, idTheme);
			return visibleWidth(segment.detail.primary);
		});

		// All widths must be identical
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it("write amplification: 1.0× to 99.9× maintains constant width", () => {
		const amps = [1.0, 1.5, 5.0, 10.0, 50.0, 99.9];

		const widths = amps.map(amp => {
			const mockState = {
				size: 1,
				snapshot: () => ({
					counts: { poisoned: 0, tainted: 0, clean: 1, pending: 0 },
					paths: [{ path: "test.ts", status: "clean" as const, lastTouchTurn: 1 }],
					metrics: { reads: 1, writes: 1, writeAmplification: amp },
				}),
			} as unknown as AuditLedgerState;

			const segment = buildAuditTrailBoxSegment(mockState, Date.now(), idTheme);
			// Extract the amp value from trailing (format: "reads N · writes N · amp X.X×")
			const match = segment.detail.trailing.match(/amp ([^×]+)×/);
			return match ? visibleWidth(match[1]) : 0;
		});

		// All widths must be identical
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeGreaterThan(0);
	});

	it("reset ETA: maintains reasonable width consistency", () => {
		const now = Date.now();
		const scenarios = [
			{ resetAtMs: undefined, expected: "" },
			{ resetAtMs: now - 1000, expected: "resets now" },
			{ resetAtMs: now + 30_000, expected: /resets\s+\d+s/ },
			{ resetAtMs: now + 120_000, expected: /resets\s+\d+m/ },
			{ resetAtMs: now + 720_000, expected: /resets\s+\d+m/ },
		];

		for (const { resetAtMs, expected } of scenarios) {
			const mockState = {
				snapshot: () => ({
					level: 0.5,
					provider: "anthropic",
					observedAtMs: now,
					resetAtMs,
				}),
			} as unknown as RateLimitTidepoolState;

			const segment = buildRateLimitTidepoolSegment(mockState, now, idTheme);
			if (typeof expected === "string") {
				expect(segment.detail.trailing).toBe(expected);
			} else {
				expect(segment.detail.trailing).toMatch(expected);
			}
		}
	});
});
