import { describe, it } from "bun:test";
import {
	TEMPORAL_EVIDENCE_KINDS,
	type TemporalEvidenceInput,
	type TemporalEvidenceKind,
	type TemporalEvidenceKindPolicy,
	type TemporalEvidencePolicy,
	type TemporalEvidenceSnapshot,
	TemporalEvidenceStore,
} from "../src/animations-box/temporal-evidence";

const SEED = 0x6d2b_79f5;
const FIRST_KIND = TEMPORAL_EVIDENCE_KINDS[0];

type NumericRecord = Readonly<Record<string, number>>;

interface DiagnosticContext {
	readonly seed: number;
	readonly operationIndex: number;
	readonly fakeTime: number;
	readonly kind: TemporalEvidenceKind;
	readonly slotAlias: number;
}

interface Scenario {
	at(operationIndex: number, fakeTime: number, kind: TemporalEvidenceKind, slotAlias: number): void;
	check(condition: boolean, counters?: NumericRecord, durations?: NumericRecord): void;
}

class EvidenceStressFailure extends Error {
	constructor(context: DiagnosticContext, counters: NumericRecord = {}, durations: NumericRecord = {}) {
		super(JSON.stringify({ ...context, counters, durations }));
		this.stack = this.message;
	}
}

function scenario(seed: number, body: (control: Scenario) => void): void {
	let context: DiagnosticContext = {
		seed,
		operationIndex: 0,
		fakeTime: 0,
		kind: FIRST_KIND,
		slotAlias: 0,
	};
	const control: Scenario = {
		at(operationIndex, fakeTime, kind, slotAlias) {
			context = { seed, operationIndex, fakeTime, kind, slotAlias };
		},
		check(condition, counters = {}, durations = {}) {
			if (!condition) throw new EvidenceStressFailure(context, counters, durations);
		},
	};
	try {
		body(control);
	} catch (error) {
		if (error instanceof EvidenceStressFailure) throw error;
		throw new EvidenceStressFailure(context, { unexpectedFailure: 1 });
	}
}

function policy(
	globalCapacity: number,
	kindCapacity: number,
	ttl: Omit<TemporalEvidenceKindPolicy, "capacity"> = {
		freshForMs: 1_000_000,
		recentForMs: 1_000_000,
		residualForMs: 1_000_000,
	},
): TemporalEvidencePolicy {
	const kinds = {} as Record<TemporalEvidenceKind, TemporalEvidenceKindPolicy>;
	for (const kind of TEMPORAL_EVIDENCE_KINDS) kinds[kind] = { capacity: kindCapacity, ...ttl };
	return { globalCapacity, kinds };
}

function pick<const T extends readonly unknown[]>(values: T, variant: number): T[number] {
	return values[Math.abs(variant) % values.length];
}

function evidence(
	kind: TemporalEvidenceKind,
	slotAlias: number,
	observedAt: number,
	variant: number,
): TemporalEvidenceInput {
	const value = Math.abs(variant);
	switch (kind) {
		case "memory-observation":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					status: pick(["available", "degraded", "unavailable"] as const, variant),
					tier: pick(["local", "remote", "hybrid", "unknown"] as const, variant >>> 2),
				},
			};
		case "causal-relation":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					relation: pick(["causes", "blocks", "unblocks", "supersedes"] as const, variant),
					strength: (value % 101) / 100,
				},
			};
		case "freshness-transition":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					from: pick(["absent", "fresh", "recent", "residual"] as const, variant),
					to: pick(["fresh", "recent", "residual", "absent"] as const, variant >>> 2),
				},
			};
		case "progress-observation":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: { completed: value % 17, total: 17 },
			};
		case "retry-schedule":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: { attempt: (value % 9) + 1, delayMs: value % 113 },
			};
		case "cancellation-relation":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					phase: pick(["requested", "acknowledged", "completed"] as const, variant),
					relatedSlot: (slotAlias + 1) % 8,
				},
			};
		case "skill-invocation":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					phase: pick(["started", "completed", "failed"] as const, variant),
					source: pick(["managed", "user", "builtin", "unknown"] as const, variant >>> 2),
				},
			};
		case "latency-sample":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					durationMs: value % 997,
					phase: pick(["first-byte", "completion", "queue", "unknown"] as const, variant),
				},
			};
		case "cache-outcome":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					outcome: pick(["hit", "miss", "bypass"] as const, variant),
					savedTokens: value % 257,
				},
			};
		case "signal-collision":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					count: (value % 23) + 1,
					resolution: pick(["coalesced", "dropped", "deferred"] as const, variant),
				},
			};
		case "numeric-history":
			return {
				kind,
				slot: slotAlias,
				observedAt,
				payload: {
					value: value % 541,
					series: pick(["rate", "count", "ratio", "duration"] as const, variant),
				},
			};
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
}

interface ModelEntry {
	readonly kind: TemporalEvidenceKind;
	readonly slotAlias: number;
	observedAt: number;
	readonly sequence: number;
}

function oldestIndex(entries: readonly ModelEntry[], kind?: TemporalEvidenceKind): number {
	let oldest = -1;
	for (let index = 0; index < entries.length; index++) {
		const candidate = entries[index];
		if (kind !== undefined && candidate.kind !== kind) continue;
		if (
			oldest < 0 ||
			candidate.observedAt < entries[oldest].observedAt ||
			(candidate.observedAt === entries[oldest].observedAt && candidate.sequence < entries[oldest].sequence)
		) {
			oldest = index;
		}
	}
	return oldest;
}

function applyModel(
	entries: ModelEntry[],
	kind: TemporalEvidenceKind,
	slotAlias: number,
	observedAt: number,
	sequence: number,
	globalCapacity: number,
	kindCapacity: number,
): boolean {
	const existing = entries.find(entry => entry.kind === kind && entry.slotAlias === slotAlias);
	if (existing !== undefined) {
		if (observedAt < existing.observedAt) return false;
		existing.observedAt = observedAt;
		return true;
	}
	entries.push({ kind, slotAlias, observedAt, sequence });
	while (entries.reduce((count, entry) => count + Number(entry.kind === kind), 0) > kindCapacity) {
		entries.splice(oldestIndex(entries, kind), 1);
	}
	while (entries.length > globalCapacity) entries.splice(oldestIndex(entries), 1);
	return entries.some(entry => entry.kind === kind && entry.slotAlias === slotAlias);
}

function snapshotCounters(snapshot: TemporalEvidenceSnapshot): NumericRecord {
	return {
		total: snapshot.counters.total,
		fresh: snapshot.counters.fresh,
		recent: snapshot.counters.recent,
		residual: snapshot.counters.residual,
	};
}

function assertMatchesModel(
	control: Scenario,
	snapshot: TemporalEvidenceSnapshot,
	model: readonly ModelEntry[],
	globalCapacity: number,
	kindCapacity: number,
): void {
	control.check(snapshot.entries.length === model.length, {
		...snapshotCounters(snapshot),
		expectedTotal: model.length,
	});
	control.check(snapshot.entries.length <= globalCapacity, {
		...snapshotCounters(snapshot),
		globalCapacity,
	});
	for (const kind of TEMPORAL_EVIDENCE_KINDS) {
		const expectedCount = model.reduce((count, entry) => count + Number(entry.kind === kind), 0);
		control.check(snapshot.counters.byKind[kind] === expectedCount, {
			...snapshotCounters(snapshot),
			actualKindCount: snapshot.counters.byKind[kind],
			expectedKindCount: expectedCount,
			kindCapacity,
		});
		control.check(snapshot.counters.byKind[kind] <= kindCapacity, {
			...snapshotCounters(snapshot),
			actualKindCount: snapshot.counters.byKind[kind],
			kindCapacity,
		});
	}
	const unique = new Set(snapshot.entries.map(entry => `${entry.kind}:${entry.slot}`));
	control.check(unique.size === snapshot.entries.length, {
		...snapshotCounters(snapshot),
		uniqueCount: unique.size,
	});
	for (let index = 0; index < model.length; index++) {
		const actual = snapshot.entries[index];
		const expected = model[index];
		control.check(actual.kind === expected.kind, {
			...snapshotCounters(snapshot),
			entryIndex: index,
			actualKindIndex: TEMPORAL_EVIDENCE_KINDS.indexOf(actual.kind),
			expectedKindIndex: TEMPORAL_EVIDENCE_KINDS.indexOf(expected.kind),
		});
		control.check(actual.slot === expected.slotAlias && actual.observedAt === expected.observedAt, {
			...snapshotCounters(snapshot),
			entryIndex: index,
			actualSlotAlias: actual.slot,
			expectedSlotAlias: expected.slotAlias,
			actualObservedAt: actual.observedAt,
			expectedObservedAt: expected.observedAt,
		});
	}
}

interface PopulationItem {
	readonly kind: TemporalEvidenceKind;
	readonly slotAlias: number;
	readonly variant: number;
}

interface BenchmarkSample {
	readonly insertMs: number;
	readonly coalesceMs: number;
	readonly snapshotMs: number;
	readonly expireMs: number;
	readonly totalMs: number;
}

function shuffledPopulation(seed: number, perKindCapacity: number): PopulationItem[] {
	const random = createRandom(seed);
	const population = TEMPORAL_EVIDENCE_KINDS.flatMap(kind =>
		Array.from({ length: perKindCapacity }, (_, slotAlias) => ({
			kind,
			slotAlias,
			variant: random(),
		})),
	);
	for (let index = population.length - 1; index > 0; index--) {
		const swap = random() % (index + 1);
		[population[index], population[swap]] = [population[swap], population[index]];
	}
	return population;
}

function benchmarkSample(
	control: Scenario,
	benchmarkPolicy: TemporalEvidencePolicy,
	population: readonly PopulationItem[],
	operationIndex: number,
): BenchmarkSample {
	const fakeTime = 100;
	const replacementOffset = benchmarkPolicy.kinds[FIRST_KIND].capacity;
	const replacements = population.map(item => ({
		kind: item.kind,
		slotAlias: item.slotAlias + replacementOffset,
		variant: item.variant + 1,
	}));
	const last = replacements[replacements.length - 1];
	const baseOperationIndex = operationIndex * 4;
	control.at(baseOperationIndex, fakeTime, last.kind, last.slotAlias);
	const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: benchmarkPolicy });
	for (const item of population) {
		store.observe(evidence(item.kind, item.slotAlias, fakeTime, item.variant));
	}
	const initial = store.snapshot(fakeTime);
	control.check(initial.counters.total === population.length, {
		...snapshotCounters(initial),
		expectedTotal: population.length,
	});

	control.at(baseOperationIndex + 1, fakeTime + 1, last.kind, last.slotAlias);
	const totalStart = performance.now();
	const insertStart = performance.now();
	for (const item of replacements) {
		store.observe(evidence(item.kind, item.slotAlias, fakeTime + 1, item.variant));
	}
	const insertMs = performance.now() - insertStart;

	const firstSnapshotStart = performance.now();
	const populated = store.snapshot(fakeTime + 1);
	const firstSnapshotMs = performance.now() - firstSnapshotStart;
	control.check(populated.counters.total === population.length, {
		...snapshotCounters(populated),
		expectedTotal: population.length,
	});

	control.at(baseOperationIndex + 2, fakeTime + 2, last.kind, last.slotAlias);
	const coalesceStart = performance.now();
	for (const item of replacements) {
		store.observe(evidence(item.kind, item.slotAlias, fakeTime + 2, item.variant + 1));
	}
	const coalesceMs = performance.now() - coalesceStart;

	const secondSnapshotStart = performance.now();
	const coalesced = store.snapshot(fakeTime + 2);
	const secondSnapshotMs = performance.now() - secondSnapshotStart;
	control.check(coalesced.counters.total === population.length, {
		...snapshotCounters(coalesced),
		expectedTotal: population.length,
	});

	control.at(baseOperationIndex + 3, fakeTime + 5, last.kind, last.slotAlias);
	const expireStart = performance.now();
	const expired = store.snapshot(fakeTime + 5);
	const expireMs = performance.now() - expireStart;
	control.check(expired.counters.total === 0, snapshotCounters(expired));
	return {
		insertMs,
		coalesceMs,
		snapshotMs: firstSnapshotMs + secondSnapshotMs,
		expireMs,
		totalMs: performance.now() - totalStart,
	};
}

function distribution(samples: readonly number[]): Readonly<{ p50: number; p95: number; max: number }> {
	const sorted = [...samples].sort((left, right) => left - right);
	const at = (quantile: number) => sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
	return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function rounded(value: number): number {
	return Math.round(value * 1_000) / 1_000;
}

describe("TemporalEvidenceStore deterministic stress contract", () => {
	it("keeps seeded sequences bounded and coalesces every registered kind/slot", () => {
		scenario(SEED, control => {
			const globalCapacity = 19;
			const kindCapacity = 3;
			const store = new TemporalEvidenceStore({
				scope: { root: 0, session: 0 },
				policy: policy(globalCapacity, kindCapacity),
			});
			const model: ModelEntry[] = [];
			const random = createRandom(SEED);
			const coalescedKinds = new Set<TemporalEvidenceKind>();
			const maximumByKind = Object.fromEntries(TEMPORAL_EVIDENCE_KINDS.map(kind => [kind, 0])) as Record<
				TemporalEvidenceKind,
				number
			>;
			let maximumTotal = 0;
			let operationIndex = 0;
			let fakeTime = 10;
			let sequence = 0;

			const apply = (kind: TemporalEvidenceKind, slotAlias: number) => {
				fakeTime += 1 + (random() % 3);
				control.at(operationIndex, fakeTime, kind, slotAlias);
				const existed = model.some(entry => entry.kind === kind && entry.slotAlias === slotAlias);
				const expectedAccepted = applyModel(
					model,
					kind,
					slotAlias,
					fakeTime,
					sequence++,
					globalCapacity,
					kindCapacity,
				);
				const accepted = store.observe(evidence(kind, slotAlias, fakeTime, random()));
				control.check(accepted === expectedAccepted, {
					accepted: Number(accepted),
					expectedAccepted: Number(expectedAccepted),
				});
				if (existed) coalescedKinds.add(kind);
				const snapshot = store.snapshot(fakeTime);
				assertMatchesModel(control, snapshot, model, globalCapacity, kindCapacity);
				control.check(store.snapshot(fakeTime) === snapshot, snapshotCounters(snapshot));
				maximumTotal = Math.max(maximumTotal, snapshot.counters.total);
				for (const registeredKind of TEMPORAL_EVIDENCE_KINDS) {
					maximumByKind[registeredKind] = Math.max(
						maximumByKind[registeredKind],
						snapshot.counters.byKind[registeredKind],
					);
				}
				operationIndex++;
			};

			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				for (let slotAlias = 0; slotAlias < 6; slotAlias++) apply(kind, slotAlias);
				apply(kind, 4);
				apply(kind, 5);
			}
			for (let index = 0; index < 480; index++) {
				const kind = TEMPORAL_EVIDENCE_KINDS[random() % TEMPORAL_EVIDENCE_KINDS.length];
				apply(kind, random() % 8);
			}

			control.at(operationIndex, fakeTime, FIRST_KIND, 0);
			control.check(maximumTotal === globalCapacity, { maximumTotal, globalCapacity });
			control.check(coalescedKinds.size === TEMPORAL_EVIDENCE_KINDS.length, {
				coalescedKindCount: coalescedKinds.size,
				registeredKindCount: TEMPORAL_EVIDENCE_KINDS.length,
			});
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, fakeTime, kind, 0);
				control.check(maximumByKind[kind] === kindCapacity, {
					maximumKindCount: maximumByKind[kind],
					kindCapacity,
				});
			}
		});
	});

	it("never lets old observations extend expiry or resurrect expired evidence without ticks", () => {
		scenario(SEED ^ 0x1111_1111, control => {
			const ttl = { freshForMs: 5, recentForMs: 7, residualForMs: 11 };
			const store = new TemporalEvidenceStore({
				scope: { root: 0, session: 0 },
				policy: policy(TEMPORAL_EVIDENCE_KINDS.length, 1, ttl),
			});
			const observedAt = 100;
			let operationIndex = 0;
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, observedAt, kind, 0);
				control.check(store.observe(evidence(kind, 0, observedAt, 0)), {
					accepted: 0,
				});
			}
			const initial = store.snapshot(observedAt);
			control.check(initial.counters.total === TEMPORAL_EVIDENCE_KINDS.length, snapshotCounters(initial));

			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, observedAt, kind, 0);
				control.check(store.observe(evidence(kind, 0, observedAt, 1)), {
					accepted: 0,
				});
			}
			const coalesced = store.snapshot(observedAt);
			control.check(
				coalesced !== initial && coalesced.counters.total === initial.counters.total,
				snapshotCounters(coalesced),
			);
			for (const entry of coalesced.entries) {
				control.at(operationIndex++, observedAt, entry.kind, entry.slot);
				const original = initial.entries.find(candidate => candidate.kind === entry.kind);
				control.check(original !== undefined && entry.expiresAt === original.expiresAt, {
					expiresAt: entry.expiresAt,
					expectedExpiresAt: observedAt + 23,
				});
			}

			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, observedAt, kind, 0);
				const accepted = store.observe(evidence(kind, 0, observedAt - 1, operationIndex + 100));
				control.check(!accepted, { accepted: Number(accepted) });
				control.check(store.snapshot(observedAt) === coalesced, snapshotCounters(coalesced));
			}
			control.at(operationIndex++, observedAt + 22, FIRST_KIND, 0);

			const residual = store.snapshot(observedAt + 22);
			control.check(residual.counters.residual === TEMPORAL_EVIDENCE_KINDS.length, snapshotCounters(residual));
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, observedAt + 22, kind, 0);
				control.check(!store.observe(evidence(kind, 0, observedAt - 1, operationIndex + 200)), {
					accepted: 1,
				});
			}
			control.at(operationIndex++, observedAt + 23, FIRST_KIND, 0);
			const expired = store.snapshot(observedAt + 23);
			control.check(expired.counters.total === 0, snapshotCounters(expired));

			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, observedAt + 23, kind, 0);
				store.observe(evidence(kind, 0, observedAt - 1, operationIndex + 300));
			}
			const afterOldReplay = store.snapshot(observedAt + 23);
			control.check(afterOldReplay.counters.total === 0, snapshotCounters(afterOldReplay));
			control.check(store.snapshot(observedAt + 23) === afterOldReplay, snapshotCounters(afterOldReplay));
		});
	});

	it("reuses deeply immutable snapshots until an observable stage changes", () => {
		scenario(SEED ^ 0x2222_2222, control => {
			const store = new TemporalEvidenceStore({
				scope: { root: 0, session: 0 },
				policy: policy(TEMPORAL_EVIDENCE_KINDS.length, 1, {
					freshForMs: 5,
					recentForMs: 7,
					residualForMs: 11,
				}),
			});
			let operationIndex = 0;
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, 100, kind, 0);
				store.observe(evidence(kind, 0, 100, operationIndex));
			}
			const fresh = store.snapshot(100);
			control.at(operationIndex++, 104, FIRST_KIND, 0);
			control.check(store.snapshot(104) === fresh, snapshotCounters(fresh));
			control.check(Object.isFrozen(fresh) && Object.isFrozen(fresh.entries), snapshotCounters(fresh));
			control.check(
				Object.isFrozen(fresh.counters) && Object.isFrozen(fresh.counters.byKind),
				snapshotCounters(fresh),
			);
			control.check(!Reflect.set(fresh, "revision", fresh.revision), snapshotCounters(fresh));
			control.check(!Reflect.set(fresh.entries, "0", fresh.entries[0]), snapshotCounters(fresh));
			control.check(!Reflect.set(fresh.counters, "total", fresh.counters.total), snapshotCounters(fresh));
			control.check(
				!Reflect.set(fresh.counters.byKind, FIRST_KIND, fresh.counters.byKind[FIRST_KIND]),
				snapshotCounters(fresh),
			);
			for (const entry of fresh.entries) {
				control.at(operationIndex++, 104, entry.kind, entry.slot);
				control.check(Object.isFrozen(entry) && Object.isFrozen(entry.payload), snapshotCounters(fresh));
				control.check(!Reflect.set(entry, "observedAt", entry.observedAt), snapshotCounters(fresh));
				const payloadKey = Object.keys(entry.payload)[0];
				control.check(
					!Reflect.set(entry.payload, payloadKey, Reflect.get(entry.payload, payloadKey)),
					snapshotCounters(fresh),
				);
			}
			control.check(store.snapshot(104) === fresh, snapshotCounters(fresh));

			control.at(operationIndex++, 105, FIRST_KIND, 0);
			const recent = store.snapshot(105);
			control.check(recent !== fresh && recent.counters.recent === fresh.counters.total, snapshotCounters(recent));
			control.at(operationIndex++, 111, FIRST_KIND, 0);
			control.check(store.snapshot(111) === recent, snapshotCounters(recent));
			control.at(operationIndex++, 112, FIRST_KIND, 0);
			const residual = store.snapshot(112);
			control.check(
				residual !== recent && residual.counters.residual === recent.counters.total,
				snapshotCounters(residual),
			);
			control.at(operationIndex++, 122, FIRST_KIND, 0);
			control.check(store.snapshot(122) === residual, snapshotCounters(residual));
			control.at(operationIndex++, 123, FIRST_KIND, 0);
			const expired = store.snapshot(123);
			control.check(expired !== residual && expired.counters.total === 0, snapshotCounters(expired));
		});
	});

	it("isolates roots, sessions, store instances, and disposed state", () => {
		scenario(SEED ^ 0x3333_3333, control => {
			const sharedPolicy = policy(TEMPORAL_EVIDENCE_KINDS.length, 1);
			const first = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: sharedPolicy });
			const second = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy: sharedPolicy });
			let operationIndex = 0;
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, 50, kind, 0);
				first.observe(evidence(kind, 0, 50, operationIndex));
			}
			const original = first.snapshot(50);
			const independent = second.snapshot(50);
			control.check(original.counters.total === TEMPORAL_EVIDENCE_KINDS.length, snapshotCounters(original));
			control.check(independent.counters.total === 0, snapshotCounters(independent));
			control.check(!Reflect.has(original, "root") && !Reflect.has(original, "session"), snapshotCounters(original));

			control.at(operationIndex++, 51, FIRST_KIND, 0);
			control.check(first.switchScope({ root: 1, session: 0 }), { switched: 0 });
			const afterRoot = first.snapshot(51);
			control.check(afterRoot.counters.total === 0 && afterRoot.scopeVersion === 1, snapshotCounters(afterRoot));
			for (const kind of TEMPORAL_EVIDENCE_KINDS) {
				control.at(operationIndex++, 52, kind, 1);
				first.observe(evidence(kind, 1, 52, operationIndex));
			}
			control.check(first.snapshot(52).counters.total === TEMPORAL_EVIDENCE_KINDS.length, {
				total: first.snapshot(52).counters.total,
			});

			control.at(operationIndex++, 53, FIRST_KIND, 1);
			control.check(first.switchScope({ root: 1, session: 1 }), { switched: 0 });
			const afterSession = first.snapshot(53);
			control.check(
				afterSession.counters.total === 0 && afterSession.scopeVersion === 2,
				snapshotCounters(afterSession),
			);
			control.check(first.switchScope({ root: 0, session: 0 }), { switched: 0 });
			const afterReturn = first.snapshot(54);
			control.check(
				afterReturn.counters.total === 0 && afterReturn.scopeVersion === 3,
				snapshotCounters(afterReturn),
			);
			control.check(original.counters.total === TEMPORAL_EVIDENCE_KINDS.length, snapshotCounters(original));

			first.observe(evidence(FIRST_KIND, 0, 55, 1));
			const beforeDispose = first.snapshot(55);
			first.dispose();
			const disposed = first.snapshot(0);
			control.check(disposed.disposed && disposed.counters.total === 0, snapshotCounters(disposed));
			control.check(Object.isFrozen(disposed) && Object.isFrozen(disposed.entries), snapshotCounters(disposed));
			control.check(!first.observe(evidence(FIRST_KIND, 0, 56, 2)), { accepted: 1 });
			control.check(!first.switchScope({ root: 2, session: 2 }), { switched: 1 });
			first.dispose();
			control.check(first.snapshot(1_000_000) === disposed, snapshotCounters(disposed));
			control.check(beforeDispose.counters.total === 1, snapshotCounters(beforeDispose));
		});
	});

	it("keeps warmed maximum-population operations within a generous bounded ceiling", () => {
		scenario(SEED ^ 0x4444_4444, control => {
			const perKindCapacity = 12;
			const maximumPopulation = perKindCapacity * TEMPORAL_EVIDENCE_KINDS.length;
			const benchmarkPolicy = policy(maximumPopulation, perKindCapacity, {
				freshForMs: 1,
				recentForMs: 1,
				residualForMs: 1,
			});
			const population = shuffledPopulation(SEED, perKindCapacity);
			for (let warmup = 0; warmup < 5; warmup++) {
				benchmarkSample(control, benchmarkPolicy, population, warmup);
			}
			const samples: BenchmarkSample[] = [];
			for (let sample = 0; sample < 21; sample++) {
				samples.push(benchmarkSample(control, benchmarkPolicy, population, sample + 5));
			}
			const insert = distribution(samples.map(sample => sample.insertMs));
			const coalesce = distribution(samples.map(sample => sample.coalesceMs));
			const snapshot = distribution(samples.map(sample => sample.snapshotMs));
			const expire = distribution(samples.map(sample => sample.expireMs));
			const total = distribution(samples.map(sample => sample.totalMs));
			const durations = {
				insertP50Ms: rounded(insert.p50),
				insertP95Ms: rounded(insert.p95),
				insertMaxMs: rounded(insert.max),
				coalesceP50Ms: rounded(coalesce.p50),
				coalesceP95Ms: rounded(coalesce.p95),
				coalesceMaxMs: rounded(coalesce.max),
				snapshotP50Ms: rounded(snapshot.p50),
				snapshotP95Ms: rounded(snapshot.p95),
				snapshotMaxMs: rounded(snapshot.max),
				expireP50Ms: rounded(expire.p50),
				expireP95Ms: rounded(expire.p95),
				expireMaxMs: rounded(expire.max),
				totalP50Ms: rounded(total.p50),
				totalP95Ms: rounded(total.p95),
				totalMaxMs: rounded(total.max),
			};
			control.at(26, 105, FIRST_KIND, 0);
			control.check(
				insert.p95 <= 250 && coalesce.p95 <= 250 && snapshot.p95 <= 250 && expire.p95 <= 250 && total.p95 <= 500,
				{ maximumPopulation, sampleCount: samples.length },
				durations,
			);
		});
	});
});
