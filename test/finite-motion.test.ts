import { describe, expect, it } from "bun:test";
import {
	BRAILLE_SAMPLE_CAPACITY,
	type BraillePhaseFieldInput,
	EVENT_DITHER_DOMAINS,
	EVENT_RING_CAPACITY,
	FINITE_MOTION_MAX_HEIGHT,
	FINITE_MOTION_MAX_WIDTH,
	FINITE_PHASE_MAX,
	type MultiscaleEventDitherInput,
	type ProvenanceTopologyInput,
	renderBraillePhaseField,
	renderMultiscaleEventDither,
	renderProvenanceTopologyInk,
	TOPOLOGY_EDGE_CAPACITY,
} from "../src/finite-motion";

const fieldInput = (overrides: Partial<BraillePhaseFieldInput> = {}): BraillePhaseFieldInput => ({
	samples: [0.5],
	seed: 0,
	width: 1,
	height: 1,
	phase: 0,
	glyphMode: "unicode",
	reducedMotion: false,
	...overrides,
});

const topologyInput = (overrides: Partial<ProvenanceTopologyInput> = {}): ProvenanceTopologyInput => ({
	rootLabel: "job",
	edges: [{ exact: true, label: "build", state: "pending" }],
	width: 12,
	height: 3,
	phase: FINITE_PHASE_MAX,
	glyphMode: "unicode",
	reducedMotion: false,
	...overrides,
});

const ditherInput = (overrides: Partial<MultiscaleEventDitherInput> = {}): MultiscaleEventDitherInput => ({
	samples: [0, 1, 4, 16],
	unit: 1,
	width: 4,
	height: 3,
	phase: FINITE_PHASE_MAX,
	glyphMode: "unicode",
	reducedMotion: false,
	...overrides,
});

function displayWidth(text: string): number {
	return Array.from(text).length;
}

describe("renderBraillePhaseField", () => {
	it("reproduces deterministic intermediate and terminal frames", () => {
		expect(renderBraillePhaseField(fieldInput({ phase: 0 })).lines).toEqual(["⡇"]);
		expect(renderBraillePhaseField(fieldInput({ phase: 0 })).lines).toEqual(["⡇"]);
		expect(renderBraillePhaseField(fieldInput({ phase: FINITE_PHASE_MAX })).lines).toEqual(["⢇"]);
		expect(renderBraillePhaseField(fieldInput({ phase: FINITE_PHASE_MAX })).terminal).toBe(true);
	});

	it("retargets from the current phase without restarting or overshooting", () => {
		const atCurrent = renderBraillePhaseField(fieldInput({ phase: 7 })).lines;
		const retargetStart = renderBraillePhaseField(
			fieldInput({ phase: { from: 7, target: 2, step: 0, steps: 3 } }),
		).lines;
		const retargetEnd = renderBraillePhaseField(fieldInput({ phase: { from: 7, target: 2, step: 3, steps: 3 } }));
		const atTarget = renderBraillePhaseField(fieldInput({ phase: 2 })).lines;

		expect(retargetStart).toEqual(atCurrent);
		expect(retargetEnd.lines).toEqual(atTarget);
		expect(retargetEnd.lines).toEqual(["⡜"]);
		expect(retargetEnd.terminal).toBe(true);

		for (const step of [0, 1, 2, 3, 4]) {
			const frame = renderBraillePhaseField(fieldInput({ phase: { from: 7, target: 2, step, steps: 3 } }));
			expect(frame.lines[0]).not.toBe(renderBraillePhaseField(fieldInput({ phase: 1 })).lines[0]);
		}
	});

	it("preserves every requested cell within the hard terminal bounds", () => {
		const render = renderBraillePhaseField(
			fieldInput({ samples: [0, 0.25, 0.5, 0.75, 1], width: 17, height: 4, seed: 11 }),
		);
		expect(render.width).toBe(17);
		expect(render.height).toBe(4);
		expect(render.lines).toHaveLength(4);
		expect(render.lines.every(line => displayWidth(line) === 17)).toBe(true);

		const bounded = renderBraillePhaseField(fieldInput({ width: 999, height: 999 }));
		expect(bounded.width).toBe(FINITE_MOTION_MAX_WIDTH);
		expect(bounded.height).toBe(FINITE_MOTION_MAX_HEIGHT);
	});

	it("admits only the newest fixed-capacity sample window", () => {
		const samples = Object.freeze([1, ...Array.from({ length: BRAILLE_SAMPLE_CAPACITY }, () => 0)]);
		const render = renderBraillePhaseField(fieldInput({ samples }));
		expect(render.lines).toEqual(["⠀"]);
		expect(BRAILLE_SAMPLE_CAPACITY).toBe(64);
	});

	it("provides static ASCII, no-color, and reduced-motion fallbacks", () => {
		const ascii = renderBraillePhaseField(fieldInput({ glyphMode: "ascii", color: false }));
		expect(ascii.lines).toEqual(["="]);
		expect(ascii.tokens[0]?.colorEnabled).toBe(false);
		expect(ascii.tokens[0]?.semanticColor).toBe("field");

		const reduced = renderBraillePhaseField(fieldInput({ phase: 0, reducedMotion: true }));
		expect(reduced.lines).toEqual(renderBraillePhaseField(fieldInput({ phase: FINITE_PHASE_MAX })).lines);
		expect(reduced.terminal).toBe(true);
	});

	it("is dormant without authoritative samples or drawable dimensions", () => {
		for (const render of [
			renderBraillePhaseField(fieldInput({ samples: [] })),
			renderBraillePhaseField(fieldInput({ width: 0 })),
			renderBraillePhaseField(fieldInput({ height: 0 })),
		]) {
			expect(render).toEqual({ width: 0, height: 0, lines: [], tokens: [], terminal: true });
		}
	});
});

describe("renderProvenanceTopologyInk", () => {
	it("renders one cohesive tree using exact admitted edges only", () => {
		const render = renderProvenanceTopologyInk(
			topologyInput({
				height: 4,
				edges: [
					{ exact: true, label: "build", state: "pending" },
					{ exact: true, label: "test", state: "complete" },
				],
			}),
		);
		expect(render.lines).toEqual(["● job       ", "│           ", "├─○ build   ", "└─✓ test    "]);
		expect(render.lines.every(line => displayWidth(line) === 12)).toBe(true);
	});

	it("reproduces deterministic intermediate ink without moving columns", () => {
		const intermediate = renderProvenanceTopologyInk(topologyInput({ phase: 3 }));
		const terminal = renderProvenanceTopologyInk(topologyInput());
		expect(intermediate.lines).toEqual(["○ job       ", "│           ", "· ○ build   "]);
		expect(terminal.lines).toEqual(["● job       ", "│           ", "└─○ build   "]);
		expect(intermediate.terminal).toBe(false);
		expect(intermediate.lines.map(displayWidth)).toEqual(terminal.lines.map(displayWidth));
	});

	it("renders no graph when exact provenance is absent", () => {
		const missing = renderProvenanceTopologyInk(
			topologyInput({ edges: [{ exact: false, label: "inferred", state: "active" }] }),
		);
		expect(missing).toEqual({ width: 0, height: 0, lines: [], tokens: [], terminal: true });
		expect(missing.lines.join("\n")).not.toContain("inferred");
	});

	it("keeps one uniform topology color meaning across root, trunk, and edges", () => {
		const render = renderProvenanceTopologyInk(
			topologyInput({
				color: false,
				height: 4,
				edges: [
					{ exact: true, label: "build", state: "active" },
					{ exact: true, label: "test", state: "failed" },
				],
			}),
		);
		expect(new Set(render.tokens.map(token => token.semanticColor))).toEqual(new Set(["topology"]));
		expect(render.tokens.every(token => token.colorEnabled === false)).toBe(true);
	});

	it("caps exact edges and preserves fixed topology height", () => {
		const edges = Object.freeze(
			Array.from({ length: TOPOLOGY_EDGE_CAPACITY + 8 }, (_, index) => ({
				exact: true,
				label: `edge-${index}`,
				state: "pending" as const,
			})),
		);
		const render = renderProvenanceTopologyInk(topologyInput({ edges, width: 16, height: 99 }));
		expect(render.height).toBe(FINITE_MOTION_MAX_HEIGHT);
		expect(render.tokens).toHaveLength(2 + TOPOLOGY_EDGE_CAPACITY);
		expect(render.lines.join("\n")).not.toContain(`edge-${TOPOLOGY_EDGE_CAPACITY}`);
	});

	it("provides fixed-width narrow, ASCII, no-color, and reduced fallbacks", () => {
		const narrow = renderProvenanceTopologyInk(topologyInput({ width: 3 }));
		expect(narrow.lines).toEqual(["● j", "│  ", "└─○"]);

		const ascii = renderProvenanceTopologyInk(
			topologyInput({ glyphMode: "ascii", width: 10, color: false, reducedMotion: true, phase: 0 }),
		);
		expect(ascii.lines).toEqual(["* job     ", "|         ", "\\-o build "]);
		expect(ascii.lines.every(line => /^[\x20-\x7e]+$/.test(line))).toBe(true);
		expect(ascii.tokens.every(token => token.colorEnabled === false)).toBe(true);
		expect(ascii.terminal).toBe(true);
	});

	it("is dormant for empty roots, missing edges, or insufficient height", () => {
		for (const render of [
			renderProvenanceTopologyInk(topologyInput({ rootLabel: "" })),
			renderProvenanceTopologyInk(topologyInput({ edges: [] })),
			renderProvenanceTopologyInk(topologyInput({ height: 2 })),
		]) {
			expect(render.lines).toEqual([]);
			expect(render.tokens).toEqual([]);
		}
	});
});

describe("renderMultiscaleEventDither", () => {
	it("reproduces deterministic intermediate and terminal density bands", () => {
		expect(renderMultiscaleEventDither(ditherInput({ phase: 3 })).lines).toEqual(["·▒▒▒", "··▒▒", "···▒"]);
		expect(renderMultiscaleEventDither(ditherInput()).lines).toEqual(["·███", "·░██", "··░█"]);
		expect(renderMultiscaleEventDither(ditherInput()).terminal).toBe(true);
	});

	it("uses only the fixed 1x, 4x, and 16x domains", () => {
		const render = renderMultiscaleEventDither(ditherInput());
		expect(EVENT_DITHER_DOMAINS).toEqual([1, 4, 16]);
		expect(render.tokens.map(token => token.domain)).toEqual([1, 4, 16]);
		expect(render.tokens.every(token => token.semanticColor === "dither")).toBe(true);
	});

	it("admits only the newest 12 ring samples", () => {
		const samples = Object.freeze([16, ...Array.from({ length: EVENT_RING_CAPACITY }, () => 0)]);
		const render = renderMultiscaleEventDither(ditherInput({ samples, width: EVENT_RING_CAPACITY }));
		expect(render.lines).toEqual(["············", "············", "············"]);
		expect(EVENT_RING_CAPACITY).toBe(12);
	});

	it("preserves width while right-aligning missing history", () => {
		const render = renderMultiscaleEventDither(ditherInput({ samples: [1, 4], width: 7, height: 5 }));
		expect(render.width).toBe(7);
		expect(render.height).toBe(5);
		expect(render.lines).toHaveLength(5);
		expect(render.lines.every(line => displayWidth(line) === 7)).toBe(true);
		expect(render.lines[0]?.startsWith("     ")).toBe(true);
		expect(render.tokens).toHaveLength(3);
	});

	it("provides ASCII, no-color, narrow, and reduced-motion fallbacks", () => {
		const ascii = renderMultiscaleEventDither(
			ditherInput({ glyphMode: "ascii", color: false, width: 2, phase: 0, reducedMotion: true }),
		);
		expect(ascii.lines).toEqual(["##", "##", ":#"]);
		expect(ascii.lines.every(line => /^[\x20-\x7e]+$/.test(line))).toBe(true);
		expect(ascii.tokens.every(token => token.colorEnabled === false)).toBe(true);
		expect(ascii.terminal).toBe(true);
	});

	it("is dormant without samples, a positive unit, or drawable dimensions", () => {
		for (const render of [
			renderMultiscaleEventDither(ditherInput({ samples: [] })),
			renderMultiscaleEventDither(ditherInput({ unit: 0 })),
			renderMultiscaleEventDither(ditherInput({ width: 0 })),
			renderMultiscaleEventDither(ditherInput({ height: 0 })),
		]) {
			expect(render).toEqual({ width: 0, height: 0, lines: [], tokens: [], terminal: true });
		}
	});
});
