import { describe, expect, it } from "bun:test";
import type { SegmentSample } from "../src/animations-box/segments";
import { AnimationsBoxWidget, BOX_BORDER_COLS, BOX_BORDER_ROWS } from "../src/animations-box/widget";
import { AnimationHost, type FrameScheduler, MotionPolicy } from "../src/kit";

const idTheme = { fg: (_color: string, text: string) => text };
const noopTui = { requestComponentRender: () => {} };
const fullEnv = { hasUI: true, isTTY: true, env: {} as Record<string, string | undefined> };

/** Manual frame scheduler: drives host ticks and the shared clock deterministically. */
function manualScheduler(): FrameScheduler & { advance(ms: number): void; readonly running: boolean } {
	let current = 0;
	let ticker: (() => void) | undefined;
	return {
		now: () => current,
		start(_intervalMs, tick) {
			ticker = tick;
			return () => {
				ticker = undefined;
			};
		},
		advance(ms) {
			current += ms;
			ticker?.();
		},
		get running() {
			return ticker !== undefined;
		},
	};
}

const RESTING: SegmentSample = {
	id: "cacheMeter",
	priority: 1,
	active: false,
	variants: [],
	detail: { glyph: "▤", label: "cache", primary: "—", secondary: "", trailing: "" },
};

const ACTIVE: SegmentSample = {
	id: "cacheMeter",
	priority: 1,
	active: true,
	variants: ["ACTIVE WIDE", "AW"],
	detail: { glyph: "▤", label: "cache", primary: "62.4%", secondary: "saved $0.41", trailing: "r 12K · w 2K" },
};

function makeWidget(opts: {
	samples: readonly SegmentSample[];
	detail?: "simple" | "detailed";
	onTick?: (now: number) => void;
	scheduler?: FrameScheduler;
}): AnimationsBoxWidget {
	const scheduler = opts.scheduler ?? manualScheduler();
	const policy = new MotionPolicy(fullEnv, "full");
	const host = new AnimationHost({ policy, scheduler });
	return new AnimationsBoxWidget({
		tui: noopTui,
		host,
		policy,
		theme: idTheme,
		clock: scheduler,
		onTick: opts.onTick ?? (() => {}),
		buildSamples: () => opts.samples,
		getDetail: () => opts.detail ?? "detailed",
	});
}

describe("AnimationsBoxWidget — border chrome and empty/zero-width guards", () => {
	it("renders nothing at all at zero or negative width", () => {
		const widget = makeWidget({ samples: [ACTIVE] });
		expect(widget.render(0)).toEqual([]);
		expect(widget.render(-5)).toEqual([]);
	});

	it("renders nothing when the enabled set is entirely empty — no segments, no border either", () => {
		const widget = makeWidget({ samples: [] });
		expect(widget.render(69)).toEqual([]);
	});

	it("border cost is documented as 2 rows / 4 columns", () => {
		expect(BOX_BORDER_ROWS).toBe(2);
		expect(BOX_BORDER_COLS).toBe(4);
	});
});

describe("AnimationsBoxWidget — detailed mode: one row per ENABLED segment, active or resting (Decision 5)", () => {
	it("renders exactly 3 rows (2 border + 1 content) for one enabled segment, regardless of activity", () => {
		expect(makeWidget({ samples: [RESTING], detail: "detailed" }).render(40)).toHaveLength(3);
		expect(makeWidget({ samples: [ACTIVE], detail: "detailed" }).render(40)).toHaveLength(3);
	});

	it("height scales with the enabled count, not the active count — one resting + one active still yields 4 rows", () => {
		const rows = makeWidget({ samples: [ACTIVE, RESTING], detail: "detailed" }).render(40);
		expect(rows).toHaveLength(4);
	});

	it("an idle enabled segment renders its own resting row content, not absence", () => {
		const rows = makeWidget({ samples: [RESTING], detail: "detailed" }).render(40);
		expect(rows[1]).toContain("cache");
		expect(rows[1]).toContain("—");
	});

	it("holds an exact golden resting-row frame at width 69 — the maintainer's real pane", () => {
		const width = 69;
		const inner = width - BOX_BORDER_COLS; // 65
		const cTrail = inner - (6 + 8 + 8 + 12 + 4); // 27
		const body = [
			`▤${" ".repeat(5)}`, // glyph, 6 cols
			`cache${" ".repeat(3)}`, // label, 8 cols
			`—${" ".repeat(7)}`, // primary, 8 cols
			" ".repeat(12), // secondary, 12 cols
			" ".repeat(cTrail), // trailing
		].join(" ");
		expect(body.length).toBe(inner);

		const rows = makeWidget({ samples: [RESTING], detail: "detailed" }).render(width);
		expect(rows).toEqual([`╭${"─".repeat(width - 2)}╮`, `│ ${body} │`, `╰${"─".repeat(width - 2)}╯`]);
	});

	it("truncates the trailing column first, then hard-truncates the whole row, never overflowing the border", () => {
		const overflowing: SegmentSample = {
			...ACTIVE,
			detail: { glyph: "▤", label: "cache", primary: "62.4%", secondary: "saved $0.41", trailing: "x".repeat(200) },
		};
		for (const width of [69, 45, 20, 6]) {
			const rows = makeWidget({ samples: [overflowing], detail: "detailed" }).render(width);
			for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);
		}
	});
});

describe("AnimationsBoxWidget — simple mode: exactly 3 rows always, one composed strip", () => {
	it("is always exactly 3 rows regardless of how many segments are enabled", () => {
		expect(makeWidget({ samples: [RESTING], detail: "simple" }).render(40)).toHaveLength(3);
		expect(makeWidget({ samples: [ACTIVE, RESTING], detail: "simple" }).render(40)).toHaveLength(3);
	});

	it("draws the composed row from only the ACTIVE segments — an idle one contributes nothing", () => {
		const rows = makeWidget({ samples: [RESTING], detail: "simple" }).render(40);
		// Border present, but the composed content row is blank (RESTING has no variants to compose).
		expect(rows[1]).toBe(`│ ${" ".repeat(36)} │`);
	});

	it("composes the active segment's widest-affordable variant into the strip", () => {
		const rows = makeWidget({ samples: [ACTIVE], detail: "simple" }).render(40);
		expect(rows[1]).toContain("ACTIVE WIDE");
	});
});

describe("AnimationsBoxWidget — lifecycle and per-tick hook", () => {
	it("subscribes to the host on first render and unsubscribes on dispose", () => {
		const scheduler = manualScheduler();
		const policy = new MotionPolicy(fullEnv, "full");
		const host = new AnimationHost({ policy, scheduler });
		const widget = new AnimationsBoxWidget({
			tui: noopTui,
			host,
			policy,
			theme: idTheme,
			clock: scheduler,
			onTick: () => {},
			buildSamples: () => [ACTIVE],
			getDetail: () => "detailed",
		});

		widget.render(69);
		expect(widget.animating).toBe(true);
		expect(host.subscriberCount).toBe(1);

		widget.dispose();
		expect(host.subscriberCount).toBe(0);
	});

	it("calls onTick with the shared clock's current time on every frame", () => {
		const scheduler = manualScheduler();
		const seen: number[] = [];
		const widget = makeWidget({ samples: [ACTIVE], onTick: now => seen.push(now), scheduler });
		widget.render(69);

		scheduler.advance(50);
		expect(seen).toContain(50);
		widget.dispose();
	});
});
