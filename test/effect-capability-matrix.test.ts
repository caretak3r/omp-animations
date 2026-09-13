import { describe, expect, it } from "bun:test";
import {
	FINITE_MOTION_MAX_HEIGHT,
	FINITE_MOTION_MAX_WIDTH,
	FINITE_PHASE_MAX,
	type FiniteMotionGlyphMode,
	type FiniteMotionRender,
	renderBraillePhaseField,
	renderMultiscaleEventDither,
	renderProvenanceTopologyInk,
} from "../src/finite-motion";
import {
	type CausalEvidenceLedger,
	createCausalEvidenceLedger,
	joinCausalEvidence,
	renderCausalEvidence,
} from "../src/signal-extras/causal-evidence";
import { confidenceRail, freshnessAfterglow, retargetAfterglow } from "../src/signal-extras/lifecycle-effects";
import {
	createMemoryTideState,
	MEMORY_TIDE_MAX_ROWS,
	MEMORY_TIDE_MAX_WIDTH,
	type MemoryTideState,
	memoryTideRowText,
	reduceMemoryTide,
	renderMemoryTide,
} from "../src/signal-extras/memory-tide";
import {
	appendCacheOutcome,
	buildCacheOutcome,
	type CacheOutcomeTuple,
	type CollisionFrame,
	composeCollisionDiffraction,
	quantizeDurationSamples,
} from "../src/signal-extras/metric-effects";

const PRIVATE_SENTINEL = "PRIVATE_SENTINEL_MATERIAL";
const AFTERGLOW_POLICY = { freshMs: 100, recentMs: 100, residualMs: 100 } as const;
const COLLISION_FRAME: CollisionFrame = {
	phase: "changed",
	observedAt: 100,
	facts: [
		{ sampleId: "ttftSplit", priority: 2 },
		{ sampleId: "cacheMeter", priority: 1 },
	],
};

interface CapabilityCase {
	readonly name: string;
	readonly width: number;
	readonly unicode: boolean;
	readonly color: boolean;
	readonly reducedMotion: boolean;
}

const CAPABILITY_CASES: readonly CapabilityCase[] = [
	{ name: "45-column Unicode color full motion", width: 45, unicode: true, color: true, reducedMotion: false },
	{ name: "69-column ASCII no-color full motion", width: 69, unicode: false, color: false, reducedMotion: false },
	{ name: "120-column Unicode no-color reduced motion", width: 120, unicode: true, color: false, reducedMotion: true },
	{ name: "200-column ASCII color reduced motion", width: 200, unicode: false, color: true, reducedMotion: true },
];

function displayWidth(text: string): number {
	return Array.from(text).length;
}

function expectFixedRenderBounds(render: FiniteMotionRender, requestedWidth: number, requestedHeight: number): void {
	const width = Math.min(requestedWidth, FINITE_MOTION_MAX_WIDTH);
	const height = Math.min(requestedHeight, FINITE_MOTION_MAX_HEIGHT);
	expect(render.width).toBe(width);
	expect(render.height).toBe(height);
	expect(render.lines).toHaveLength(height);
	expect(render.lines.every(line => displayWidth(line) === width)).toBeTrue();
}

function memoryState(): MemoryTideState {
	const baseline = reduceMemoryTide(createMemoryTideState(), {
		kind: "success",
		sequence: 1,
		observedAt: 100,
		status: {
			backend: "mnemopi",
			active: true,
			writable: false,
			scope: "per-project",
			workingCount: 10,
			episodicCount: 3,
			tripleCount: 20,
			lastRecall: false,
			privateMaterial: PRIVATE_SENTINEL,
		},
	});
	return reduceMemoryTide(baseline, {
		kind: "success",
		sequence: 2,
		observedAt: 200,
		status: {
			backend: "mnemopi",
			active: true,
			writable: false,
			scope: "per-project",
			workingCount: 12,
			episodicCount: 3,
			tripleCount: 20,
			lastRecall: false,
			privateMaterial: PRIVATE_SENTINEL,
		},
	});
}

function causalLedger(ttlMs = 1_000): CausalEvidenceLedger {
	const session = Symbol(PRIVATE_SENTINEL);
	let ledger = createCausalEvidenceLedger({ capacity: 4, ttlMs });
	const toolRelation = Symbol(PRIVATE_SENTINEL);
	ledger = joinCausalEvidence(ledger, { session, relation: toolRelation, kind: "tool-local-start" }, 100);
	ledger = joinCausalEvidence(ledger, { session, relation: toolRelation, kind: "tool-local-result" }, 101);
	ledger = joinCausalEvidence(
		ledger,
		{ session, relation: Symbol(PRIVATE_SENTINEL), kind: "cancellation-request" },
		102,
	);
	return ledger;
}

function finiteMotionRenders(capability: CapabilityCase): readonly FiniteMotionRender[] {
	const glyphMode: FiniteMotionGlyphMode = capability.unicode ? "unicode" : "ascii";
	const common = {
		width: capability.width,
		height: 4,
		phase: 3,
		glyphMode,
		reducedMotion: capability.reducedMotion,
		color: capability.color,
	} as const;
	return [
		renderBraillePhaseField({ ...common, samples: [0.25, 0.5, 1], seed: 11 }),
		renderProvenanceTopologyInk({
			...common,
			rootLabel: "job",
			edges: [
				{ exact: false, label: PRIVATE_SENTINEL, state: "active" },
				{ exact: true, label: "build", state: "complete" },
			],
		}),
		renderMultiscaleEventDither({ ...common, samples: [0, 1, 4, 16], unit: 1 }),
	];
}

describe("effect capability matrix", () => {
	for (const capability of CAPABILITY_CASES) {
		it(capability.name, () => {
			const state = memoryState();
			const memoryRows = renderMemoryTide(state, {
				now: 200,
				width: capability.width,
				height: 20,
				mode: capability.reducedMotion ? "reduced" : "detailed",
				symbols: capability.unicode ? "unicode" : "ascii",
				stage: "fresh",
			});
			const memoryText = memoryRows.map(memoryTideRowText).join("\n");
			expect(memoryRows.length).toBeGreaterThan(0);
			expect(memoryRows.length).toBeLessThanOrEqual(MEMORY_TIDE_MAX_ROWS);
			expect(
				memoryRows.every(
					row => displayWidth(memoryTideRowText(row)) <= Math.min(capability.width, MEMORY_TIDE_MAX_WIDTH),
				),
			).toBeTrue();
			expect(memoryText).toContain("active:yes");
			expect(memoryText).toContain("writable:no");
			expect(memoryText).toContain("searchable:?");
			if (capability.reducedMotion) {
				expect(memoryRows.flatMap(row => row.tokens).some(token => token.semantic === "motion")).toBeFalse();
			} else {
				expect(memoryText).toContain(capability.unicode ? "▓" : "#");
			}

			const afterglow = retargetAfterglow(undefined, 100, AFTERGLOW_POLICY);
			const lifecycle = freshnessAfterglow(afterglow, 100, capability);
			expect(lifecycle?.stage).toBe("fresh");
			expect(lifecycle?.glyph).toBe(
				capability.reducedMotion ? (capability.unicode ? "•" : "*") : capability.unicode ? "█" : "#",
			);
			expect(displayWidth(lifecycle?.text ?? "")).toBe(capability.width);
			expect(lifecycle?.text).toContain("fresh");

			const ledger = causalLedger();
			const causal = renderCausalEvidence(ledger, {
				now: 102,
				width: capability.width,
				unicode: capability.unicode,
				color: capability.color,
				reducedMotion: capability.reducedMotion,
				phase: 1,
			});
			expect(causal.topologies.map(topology => topology.family)).toEqual(["tool", "cancellation"]);
			expect(causal.topologies[0]?.text).toContain(capability.unicode ? "start → result" : "start > result");
			expect(causal.topologies[1]?.text).toContain("cancellation stopping");
			expect(causal.topologies.every(topology => displayWidth(topology.text) <= capability.width)).toBeTrue();
			if (!capability.color) {
				expect(
					causal.topologies.flatMap(topology => topology.tokens).every(token => token.tone === undefined),
				).toBeTrue();
			}

			const cache = buildCacheOutcome({
				layer: "provider",
				lookupClass: "prompt-prefix",
				disposition: "reused",
				cacheRead: 8,
				cacheWrite: 0,
				uncached: 2,
			});
			expect(cache).toMatchObject({ disposition: "reused", compared: 10, reused: 8, missed: 2 });
			const diffraction = composeCollisionDiffraction(COLLISION_FRAME, 100, capability);
			if (capability.reducedMotion) {
				expect(diffraction).toBeUndefined();
			} else {
				expect(diffraction?.fringe).toBe(capability.unicode ? "··╾◇◆◇╼··" : "..<.*.>..");
				expect(displayWidth(diffraction?.fringe ?? "")).toBe(9);
			}

			const finite = finiteMotionRenders(capability);
			for (const render of finite) {
				expectFixedRenderBounds(render, capability.width, 4);
				expect(render.tokens.every(token => token.colorEnabled === capability.color)).toBeTrue();
				expect(render.terminal).toBe(capability.reducedMotion);
			}
			expect(finite[0]?.lines.join("").trim().length).toBeGreaterThan(0);
			expect(finite[1]?.lines.join("\n")).toContain("job");
			expect(finite[1]?.lines.join("\n")).toContain("build");
			expect(finite[2]?.tokens.map(token => token.domain)).toEqual([1, 4, 16]);

			expect(
				renderMemoryTide(state, {
					now: 200,
					width: capability.width,
					height: 20,
					mode: capability.reducedMotion ? "reduced" : "detailed",
					symbols: capability.unicode ? "unicode" : "ascii",
					stage: "fresh",
				}),
			).toEqual(memoryRows);
			expect(
				renderCausalEvidence(ledger, {
					now: 102,
					width: capability.width,
					unicode: capability.unicode,
					color: capability.color,
					reducedMotion: capability.reducedMotion,
					phase: 1,
				}),
			).toEqual(causal);
			expect(finiteMotionRenders(capability)).toEqual(finite);
			expect(
				JSON.stringify({ state, memoryRows, lifecycle, ledger, causal, cache, diffraction, finite }),
			).not.toContain(PRIVATE_SENTINEL);
		});
	}

	it("expires finite lifecycle stages without inventing completion", () => {
		const afterglow = retargetAfterglow(undefined, 0, AFTERGLOW_POLICY);
		const render = { width: 45, unicode: true, color: false, reducedMotion: false } as const;
		expect([0, 100, 200].map(now => freshnessAfterglow(afterglow, now, render)?.stage)).toEqual([
			"fresh",
			"recent",
			"residual",
		]);
		expect(freshnessAfterglow(afterglow, 300, render)).toBeUndefined();

		const eventOnly = confidenceRail({ kind: "event-only", observedAt: 0 }, 0, render);
		expect(eventOnly).toMatchObject({ kind: "event-only", recent: true, stage: "fresh" });
		expect(eventOnly?.text).toContain("updated");
		expect(eventOnly?.text).not.toContain("%");
		expect(eventOnly === undefined || !("ratio" in eventOnly)).toBeTrue();
		expect(eventOnly === undefined || !("percent" in eventOnly)).toBeTrue();

		expect(
			[0, 200, 400, 600].map(
				age =>
					composeCollisionDiffraction(COLLISION_FRAME, 100 + age, {
						width: 45,
						unicode: true,
						color: false,
						reducedMotion: false,
					})?.stage,
			),
		).toEqual([1, 2, 3, "static"]);
		expect(
			composeCollisionDiffraction(COLLISION_FRAME, 1_300, {
				width: 45,
				unicode: true,
				color: false,
				reducedMotion: false,
			}),
		).toBeUndefined();
	});

	it("keeps unsupported, unproven, and empty inputs dormant", () => {
		expect(renderMemoryTide(createMemoryTideState(), { now: 0, width: 45, height: 3, mode: "detailed" })).toEqual([]);
		expect(freshnessAfterglow(undefined, 0, { width: 45 })).toBeUndefined();

		const rejectedLedger = joinCausalEvidence(
			createCausalEvidenceLedger(),
			{ session: Symbol(PRIVATE_SENTINEL), relation: Symbol(PRIVATE_SENTINEL), kind: "tool-local-result" },
			0,
		);
		const rejectedCausal = renderCausalEvidence(rejectedLedger, {
			now: 0,
			width: 45,
			unicode: true,
			color: false,
			reducedMotion: true,
			phase: 0,
		});
		expect(rejectedCausal.topologies).toEqual([]);
		expect(
			rejectedCausal.topologies.flatMap(topology => topology.tokens).filter(token => token.role === "edge"),
		).toEqual([]);

		const unknownCache = buildCacheOutcome({
			layer: "provider",
			lookupClass: "prompt-prefix",
			disposition: undefined,
			cacheRead: 8,
			cacheWrite: 0,
			uncached: 2,
		});
		expect(unknownCache).toBeUndefined();
		expect(
			quantizeDurationSamples([
				{ operationClass: "ttft", durationMs: 10 },
				{ operationClass: "ttft", durationMs: 11 },
				{ operationClass: "ttft", durationMs: 9 },
				{ operationClass: "ttft", durationMs: 10 },
			]),
		).toBeUndefined();
		expect(
			composeCollisionDiffraction({ ...COLLISION_FRAME, phase: "stable" }, 100, {
				width: 45,
				unicode: true,
				color: false,
				reducedMotion: false,
			}),
		).toBeUndefined();

		const empty = { width: 0, height: 0, lines: [], tokens: [], terminal: true };
		const emptyField = renderBraillePhaseField({
			samples: [],
			seed: 0,
			width: 45,
			height: 4,
			phase: FINITE_PHASE_MAX,
			glyphMode: "unicode",
			reducedMotion: false,
		});
		const rejectedTopology = renderProvenanceTopologyInk({
			rootLabel: "job",
			edges: [{ exact: false, label: PRIVATE_SENTINEL, state: "active" }],
			width: 45,
			height: 4,
			phase: FINITE_PHASE_MAX,
			glyphMode: "unicode",
			reducedMotion: false,
		});
		const emptyDither = renderMultiscaleEventDither({
			samples: [1],
			unit: 0,
			width: 45,
			height: 4,
			phase: FINITE_PHASE_MAX,
			glyphMode: "unicode",
			reducedMotion: false,
		});
		expect(emptyField).toEqual(empty);
		expect(rejectedTopology).toEqual(empty);
		expect(emptyDither).toEqual(empty);
		expect(JSON.stringify({ rejectedLedger, rejectedCausal, unknownCache, rejectedTopology })).not.toContain(
			PRIVATE_SENTINEL,
		);
	});

	it("enforces bounded populations and terminal dimensions", () => {
		let ledger = createCausalEvidenceLedger({ capacity: 1, ttlMs: 10 });
		for (const now of [0, 1]) {
			const session = Symbol(PRIVATE_SENTINEL);
			const relation = Symbol(PRIVATE_SENTINEL);
			ledger = joinCausalEvidence(ledger, { session, relation, kind: "tool-local-start" }, now);
			ledger = joinCausalEvidence(ledger, { session, relation, kind: "tool-local-result" }, now);
		}
		expect(
			renderCausalEvidence(ledger, {
				now: 1,
				width: 45,
				unicode: true,
				color: false,
				reducedMotion: true,
				phase: 0,
			}).topologies,
		).toHaveLength(1);
		expect(
			renderCausalEvidence(ledger, {
				now: 11,
				width: 45,
				unicode: true,
				color: false,
				reducedMotion: true,
				phase: 0,
			}).topologies,
		).toEqual([]);

		let cacheHistory: readonly CacheOutcomeTuple[] = [];
		for (let count = 1; count <= 12; count++) {
			cacheHistory = appendCacheOutcome(cacheHistory, {
				layer: "provider",
				lookupClass: "system-tools",
				disposition: "reused",
				cacheRead: count,
				cacheWrite: 0,
				uncached: 0,
			});
		}
		expect(cacheHistory).toHaveLength(8);
		expect(cacheHistory.map(outcome => outcome.reused)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);

		const bounded = renderBraillePhaseField({
			samples: [1],
			seed: 0,
			width: 200,
			height: 200,
			phase: FINITE_PHASE_MAX,
			glyphMode: "ascii",
			reducedMotion: true,
			color: false,
		});
		expectFixedRenderBounds(bounded, 200, 200);
		expect(bounded.width).toBe(FINITE_MOTION_MAX_WIDTH);
		expect(bounded.height).toBe(FINITE_MOTION_MAX_HEIGHT);
	});
});
