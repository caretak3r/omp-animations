const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80] as const;
const ASCII_DENSITY = [" ", ".", ":", "-", "=", "+", "*", "#", "@"] as const;
const UNICODE_DITHER = ["·", "░", "▒", "▓", "█"] as const;
const ASCII_DITHER = [".", ":", "-", "=", "#"] as const;

/** Every finite-motion renderer is bounded by these terminal dimensions. */
export const FINITE_MOTION_MAX_WIDTH = 80;
export const FINITE_MOTION_MAX_HEIGHT = 16;
export const FINITE_PHASE_MAX = 7;
export const BRAILLE_SAMPLE_CAPACITY = 64;
export const TOPOLOGY_EDGE_CAPACITY = FINITE_MOTION_MAX_HEIGHT - 2;
export const EVENT_RING_CAPACITY = 12;
export const EVENT_DITHER_DOMAINS = [1, 4, 16] as const;

export type FiniteMotionGlyphMode = "unicode" | "ascii";
export type FiniteMotionSemanticColor = "field" | "topology" | "dither";
export type EventDitherDomain = (typeof EVENT_DITHER_DOMAINS)[number];

/**
 * A transition can begin at the caller's current phase instead of restarting
 * at zero. All fields are quantized and clamped to the finite phase domain.
 */
export interface FinitePhaseRetarget {
	readonly from: number;
	readonly target: number;
	readonly step: number;
	readonly steps: number;
}

export type QuantizedFinitePhase = number | FinitePhaseRetarget;

export interface FiniteMotionToken {
	readonly row: number;
	readonly text: string;
	readonly semanticColor: FiniteMotionSemanticColor;
	readonly colorEnabled: boolean;
	readonly domain?: EventDitherDomain;
}

export interface FiniteMotionRender {
	readonly width: number;
	readonly height: number;
	readonly lines: readonly string[];
	readonly tokens: readonly FiniteMotionToken[];
	readonly terminal: boolean;
}

interface CommonFiniteMotionInput {
	readonly width: number;
	readonly height: number;
	readonly phase: QuantizedFinitePhase;
	readonly glyphMode: FiniteMotionGlyphMode;
	readonly reducedMotion: boolean;
	readonly color?: boolean;
}

export interface BraillePhaseFieldInput extends CommonFiniteMotionInput {
	/** Normalized safe numeric samples. Values outside [0, 1] are clamped. */
	readonly samples: readonly number[];
	readonly seed: number;
}

export type TopologyNodeState = "pending" | "active" | "complete" | "failed";

export interface AdmittedTopologyEdge {
	/** Only literal true represents an exact, authoritative provenance join. */
	readonly exact: boolean;
	readonly label: string;
	readonly state: TopologyNodeState;
}

export interface ProvenanceTopologyInput extends CommonFiniteMotionInput {
	readonly rootLabel: string;
	readonly edges: readonly AdmittedTopologyEdge[];
}

export interface MultiscaleEventDitherInput extends CommonFiniteMotionInput {
	/** Oldest-to-newest fixed-ring values; only the newest 12 are admitted. */
	readonly samples: readonly number[];
	/** Fixed 1x ceiling. The other ceilings are exactly 4x and 16x this value. */
	readonly unit: number;
}

interface ResolvedPhase {
	readonly value: number;
	readonly terminal: boolean;
}

function boundedInteger(value: number, maximum: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function normalizedSample(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return value >= 1 ? 1 : value;
}

function resolvePhase(phase: QuantizedFinitePhase, reducedMotion: boolean): ResolvedPhase {
	if (typeof phase === "number") {
		const value = reducedMotion ? FINITE_PHASE_MAX : boundedInteger(Math.round(phase), FINITE_PHASE_MAX);
		return { value, terminal: reducedMotion || value === FINITE_PHASE_MAX };
	}

	const from = boundedInteger(Math.round(phase.from), FINITE_PHASE_MAX);
	const target = boundedInteger(Math.round(phase.target), FINITE_PHASE_MAX);
	if (reducedMotion) return { value: target, terminal: true };

	const steps = Math.max(1, boundedInteger(Math.round(phase.steps), FINITE_PHASE_MAX));
	const step = Math.min(steps, boundedInteger(Math.round(phase.step), steps));
	const value = Math.round(from + ((target - from) * step) / steps);
	return { value, terminal: step === steps };
}

function emptyRender(): FiniteMotionRender {
	return { width: 0, height: 0, lines: [], tokens: [], terminal: true };
}

function sanitizeCell(character: string): string {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint < 0x20 || codePoint === 0x7f ? "?" : character;
}

function fitToWidth(text: string, width: number): string {
	let output = "";
	let columns = 0;
	for (const character of text) {
		if (columns === width) break;
		output += sanitizeCell(character);
		columns++;
	}
	return output + " ".repeat(width - columns);
}

function appendPadding(lines: string[], height: number, width: number): void {
	while (lines.length < height) lines.push(" ".repeat(width));
}

function makeToken(
	row: number,
	text: string,
	semanticColor: FiniteMotionSemanticColor,
	colorEnabled: boolean,
	domain?: EventDitherDomain,
): FiniteMotionToken {
	return domain === undefined
		? { row, text, semanticColor, colorEnabled }
		: { row, text, semanticColor, colorEnabled, domain };
}

/**
 * Render a deterministic subcell field. Sample count, cell count, phase count,
 * and seed influence are all bounded; no frame depends on prior renderer state.
 */
export function renderBraillePhaseField(input: BraillePhaseFieldInput): FiniteMotionRender {
	const width = boundedInteger(input.width, FINITE_MOTION_MAX_WIDTH);
	const height = boundedInteger(input.height, FINITE_MOTION_MAX_HEIGHT);
	if (input.samples.length === 0 || width === 0 || height === 0) return emptyRender();

	const phase = resolvePhase(input.phase, input.reducedMotion);
	const sampleCount = Math.min(input.samples.length, BRAILLE_SAMPLE_CAPACITY);
	const sampleStart = input.samples.length - sampleCount;
	const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed) >>> 0 : 0;
	const lines: string[] = [];
	const tokens: FiniteMotionToken[] = [];
	const colorEnabled = input.color !== false;

	for (let row = 0; row < height; row++) {
		let line = "";
		for (let column = 0; column < width; column++) {
			const cell = row * width + column;
			const sampleOffset = cell % sampleCount;
			const density = Math.round(normalizedSample(input.samples[sampleStart + sampleOffset] ?? 0) * 8);
			if (input.glyphMode === "ascii") {
				line += ASCII_DENSITY[density] ?? " ";
				continue;
			}

			const dotOffset = (seed + cell * 3 + sampleOffset * 5 + phase.value) % BRAILLE_DOTS.length;
			let pattern = 0;
			for (let dot = 0; dot < density; dot++) {
				pattern |= BRAILLE_DOTS[(dotOffset + dot) % BRAILLE_DOTS.length] ?? 0;
			}
			line += String.fromCodePoint(BRAILLE_BASE + pattern);
		}
		lines.push(line);
		tokens.push(makeToken(row, line, "field", colorEnabled));
	}

	return { width, height, lines, tokens, terminal: phase.terminal };
}

function topologyStateGlyph(state: TopologyNodeState, mode: FiniteMotionGlyphMode): string {
	if (mode === "ascii") {
		if (state === "active") return ">";
		if (state === "complete") return "+";
		if (state === "failed") return "x";
		return "o";
	}
	if (state === "active") return "◐";
	if (state === "complete") return "✓";
	if (state === "failed") return "×";
	return "○";
}

function topologyConnector(last: boolean, phase: number, mode: FiniteMotionGlyphMode): string {
	if (phase <= 1) return "  ";
	if (phase <= 3) return mode === "ascii" ? ". " : "· ";
	if (phase <= 5) return mode === "ascii" ? "+." : last ? "└·" : "├·";
	return mode === "ascii" ? (last ? "\\-" : "+-") : last ? "└─" : "├─";
}

/**
 * Render one root/trunk/edge topology. The renderer never infers joins: an edge
 * appears only when its input carries the exact-admission bit.
 */
export function renderProvenanceTopologyInk(input: ProvenanceTopologyInput): FiniteMotionRender {
	const width = boundedInteger(input.width, FINITE_MOTION_MAX_WIDTH);
	const height = boundedInteger(input.height, FINITE_MOTION_MAX_HEIGHT);
	if (input.rootLabel.length === 0 || width === 0 || height < 3) return emptyRender();

	const admitted: AdmittedTopologyEdge[] = [];
	const admissionCapacity = Math.min(TOPOLOGY_EDGE_CAPACITY, height - 2);
	for (let index = 0; index < input.edges.length && admitted.length < admissionCapacity; index++) {
		const edge = input.edges[index];
		if (edge?.exact === true) admitted.push(edge);
	}
	if (admitted.length === 0) return emptyRender();

	const phase = resolvePhase(input.phase, input.reducedMotion);
	const colorEnabled = input.color !== false;
	const lines: string[] = [];
	const tokens: FiniteMotionToken[] = [];
	const rootGlyph =
		input.glyphMode === "ascii"
			? phase.value === FINITE_PHASE_MAX
				? "*"
				: "o"
			: phase.value === FINITE_PHASE_MAX
				? "●"
				: "○";
	const rootLine = fitToWidth(`${rootGlyph} ${input.rootLabel}`, width);
	lines.push(rootLine);
	tokens.push(makeToken(0, rootLine, "topology", colorEnabled));

	const trunkGlyph =
		phase.value <= 2 ? (input.glyphMode === "ascii" ? "." : "·") : input.glyphMode === "ascii" ? "|" : "│";
	const trunkLine = fitToWidth(trunkGlyph, width);
	lines.push(trunkLine);
	tokens.push(makeToken(1, trunkLine, "topology", colorEnabled));

	const visibleEdges = Math.min(admitted.length, height - lines.length);
	for (let index = 0; index < visibleEdges; index++) {
		const edge = admitted[index];
		if (edge === undefined) continue;
		const connector = topologyConnector(index === visibleEdges - 1, phase.value, input.glyphMode);
		const glyph = topologyStateGlyph(edge.state, input.glyphMode);
		const line = fitToWidth(`${connector}${glyph} ${edge.label}`, width);
		lines.push(line);
		tokens.push(makeToken(lines.length - 1, line, "topology", colorEnabled));
	}

	appendPadding(lines, height, width);
	return { width, height, lines, tokens, terminal: phase.terminal };
}

function eventDitherGlyph(value: number, ceiling: number, phase: number, mode: FiniteMotionGlyphMode): string {
	const normalized = value <= 0 ? 0 : value >= ceiling ? 1 : value / ceiling;
	const animated = normalized * (phase / FINITE_PHASE_MAX);
	const density = Math.round(animated * 4);
	return mode === "ascii" ? (ASCII_DITHER[density] ?? ".") : (UNICODE_DITHER[density] ?? "·");
}

/**
 * Render the newest fixed-capacity event ring at the immutable 1x, 4x, and 16x
 * domains. Missing history is left blank; zero samples retain the lowest mark.
 */
export function renderMultiscaleEventDither(input: MultiscaleEventDitherInput): FiniteMotionRender {
	const width = boundedInteger(input.width, FINITE_MOTION_MAX_WIDTH);
	const height = boundedInteger(input.height, FINITE_MOTION_MAX_HEIGHT);
	if (input.samples.length === 0 || width === 0 || height === 0 || !Number.isFinite(input.unit) || input.unit <= 0) {
		return emptyRender();
	}

	const phase = resolvePhase(input.phase, input.reducedMotion);
	const sampleCount = Math.min(input.samples.length, EVENT_RING_CAPACITY, width);
	const sampleStart = input.samples.length - sampleCount;
	const firstColumn = width - sampleCount;
	const renderedBands = Math.min(height, EVENT_DITHER_DOMAINS.length);
	const colorEnabled = input.color !== false;
	const lines: string[] = [];
	const tokens: FiniteMotionToken[] = [];

	for (let row = 0; row < renderedBands; row++) {
		const domain = EVENT_DITHER_DOMAINS[row];
		if (domain === undefined) continue;
		const ceiling = input.unit * domain;
		let line = " ".repeat(firstColumn);
		for (let offset = 0; offset < sampleCount; offset++) {
			const raw = input.samples[sampleStart + offset] ?? 0;
			const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
			line += eventDitherGlyph(value, ceiling, phase.value, input.glyphMode);
		}
		lines.push(line);
		tokens.push(makeToken(row, line, "dither", colorEnabled, domain));
	}

	appendPadding(lines, height, width);
	return { width, height, lines, tokens, terminal: phase.terminal };
}
