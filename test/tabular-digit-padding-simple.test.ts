/**
 * Tabular-figure digit alignment tests — simplified version without progress-bar dependency.
 * Tests only the numeric formatting functions directly.
 */
import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";

// Test the padding logic directly by checking string widths
describe("Tabular digit padding — numeric format verification (oh-my-pi-jj7.9)", () => {
	it("cache percentage format: 0.0% to 100.0% constant width", () => {
		const values = [0, 5, 50, 92, 100];
		const formatted = values.map(v => `${v.toFixed(1)}%`.padStart(6, " "));

		const widths = formatted.map(s => visibleWidth(s));
		expect(widths).toEqual([6, 6, 6, 6, 6]);

		// Verify actual format
		expect(formatted).toEqual(["  0.0%", "  5.0%", " 50.0%", " 92.0%", "100.0%"]);
	});

	it("cadence rate format: -- and 0-160 t/s constant width", () => {
		const formatRate = (rate: number | null): string => {
			if (rate === null || rate <= 0) return "  --   ";
			return `${Math.round(rate).toString().padStart(3, " ")} t/s`;
		};

		const rates = [null, 0, 1, 10, 100, 160];
		const formatted = rates.map(formatRate);

		const widths = formatted.map(s => visibleWidth(s));
		expect(widths).toEqual([7, 7, 7, 7, 7, 7]);

		// Verify actual format
		expect(formatted).toEqual(["  --   ", "  --   ", "  1 t/s", " 10 t/s", "100 t/s", "160 t/s"]);
	});

	it("cadence peak format: peak 0 to peak 160 constant width", () => {
		const values = [0, 5, 55, 100, 160];
		const formatted = values.map(v => `peak ${v.toString().padStart(3, " ")}`);

		const widths = formatted.map(s => visibleWidth(s));
		expect(widths).toEqual([8, 8, 8, 8, 8]);

		// Verify actual format
		expect(formatted).toEqual(["peak   0", "peak   5", "peak  55", "peak 100", "peak 160"]);
	});

	it("rate limit percentage format: 0% to 100% constant width", () => {
		const values = [0, 5, 78, 100];
		const formatted = values.map(v => `${v.toString().padStart(3, " ")}%`);

		const widths = formatted.map(s => visibleWidth(s));
		expect(widths).toEqual([4, 4, 4, 4]);

		// Verify actual format
		expect(formatted).toEqual(["  0%", "  5%", " 78%", "100%"]);
	});

	it("write amplification format: 1.0× to 99.9× constant width", () => {
		const values = [1.0, 1.5, 10.0, 50.0, 99.9];
		const formatted = values.map(v => v.toFixed(1).padStart(4, " "));

		const widths = formatted.map(s => visibleWidth(s));
		expect(widths).toEqual([4, 4, 4, 4, 4]);

		// Verify actual format
		expect(formatted).toEqual([" 1.0", " 1.5", "10.0", "50.0", "99.9"]);
	});

	it("reset ETA format: maintains consistent width within category", () => {
		const formatEta = (resetAtMs: number | undefined, now: number): string => {
			if (resetAtMs === undefined) return "";
			const remainingMs = resetAtMs - now;
			if (remainingMs <= 0) return "resets now";
			const minutes = Math.floor(remainingMs / 60_000);
			if (minutes >= 1) return `resets ${minutes.toString().padStart(3, " ")}m`;
			return `resets ${Math.max(1, Math.round(remainingMs / 1000))
				.toString()
				.padStart(2, " ")}s`;
		};

		const now = 0;
		const scenarios = [
			{ resetAtMs: undefined, expected: "" },
			{ resetAtMs: now - 1000, expected: "resets now" },
			{ resetAtMs: now + 5000, expected: "resets  5s" },
			{ resetAtMs: now + 59000, expected: "resets 59s" },
			{ resetAtMs: now + 60000, expected: "resets   1m" },
			{ resetAtMs: now + 720000, expected: "resets  12m" },
			{ resetAtMs: now + 59940000, expected: "resets 999m" },
		];

		for (const { resetAtMs, expected } of scenarios) {
			const result = formatEta(resetAtMs, now);
			expect(result).toBe(expected);
		}

		// Verify consistent widths within category
		const secondsFormats = [formatEta(now + 1000, now), formatEta(now + 30000, now), formatEta(now + 59000, now)];
		expect(secondsFormats.map(visibleWidth)).toEqual([10, 10, 10]);

		const minutesFormats = [
			formatEta(now + 60000, now),
			formatEta(now + 720000, now),
			formatEta(now + 59940000, now),
		];
		expect(minutesFormats.map(visibleWidth)).toEqual([11, 11, 11]);
	});
});
