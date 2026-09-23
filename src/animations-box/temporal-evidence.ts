export const TEMPORAL_EVIDENCE_KINDS = [
	"memory-observation",
	"causal-relation",
	"freshness-transition",
	"progress-observation",
	"retry-schedule",
	"cancellation-relation",
	"skill-invocation",
	"latency-sample",
	"cache-outcome",
	"signal-collision",
	"numeric-history",
] as const;

export type TemporalEvidenceKind = (typeof TEMPORAL_EVIDENCE_KINDS)[number];

export const TEMPORAL_EVIDENCE_STAGES = ["fresh", "recent", "residual"] as const;

export type TemporalEvidenceStage = (typeof TEMPORAL_EVIDENCE_STAGES)[number];

export interface TemporalEvidencePayloadByKind {
	"memory-observation": Readonly<{
		status: "available" | "degraded" | "unavailable";
		tier: "local" | "remote" | "hybrid" | "unknown";
	}>;
	"causal-relation": Readonly<{
		relation: "causes" | "blocks" | "unblocks" | "supersedes";
		strength: number;
	}>;
	"freshness-transition": Readonly<{
		from: TemporalEvidenceStage | "absent";
		to: TemporalEvidenceStage | "absent";
	}>;
	"progress-observation": Readonly<{
		completed: number;
		total: number;
	}>;
	"retry-schedule": Readonly<{
		attempt: number;
		delayMs: number;
	}>;
	"cancellation-relation": Readonly<{
		phase: "requested" | "acknowledged" | "completed";
		relatedSlot: number;
	}>;
	"skill-invocation": Readonly<{
		phase: "started" | "completed" | "failed";
		source: "managed" | "user" | "builtin" | "unknown";
	}>;
	"latency-sample": Readonly<{
		durationMs: number;
		phase: "first-byte" | "completion" | "queue" | "unknown";
	}>;
	"cache-outcome": Readonly<{
		outcome: "hit" | "miss" | "bypass";
		savedTokens: number;
	}>;
	"signal-collision": Readonly<{
		count: number;
		resolution: "coalesced" | "dropped" | "deferred";
	}>;
	"numeric-history": Readonly<{
		value: number;
		series: "rate" | "count" | "ratio" | "duration";
	}>;
}

export type TemporalEvidencePayload<K extends TemporalEvidenceKind = TemporalEvidenceKind> =
	TemporalEvidencePayloadByKind[K];

export type TemporalEvidenceInput<K extends TemporalEvidenceKind = TemporalEvidenceKind> =
	K extends TemporalEvidenceKind
		? Readonly<{
				kind: K;
				slot: number;
				observedAt: number;
				payload: TemporalEvidencePayload<K>;
			}>
		: never;

export type TemporalEvidenceEntry<K extends TemporalEvidenceKind = TemporalEvidenceKind> =
	K extends TemporalEvidenceKind
		? Readonly<{
				kind: K;
				slot: number;
				observedAt: number;
				payload: TemporalEvidencePayload<K>;
				stage: TemporalEvidenceStage;
				freshUntil: number;
				recentUntil: number;
				expiresAt: number;
			}>
		: never;

export interface TemporalEvidenceCounters {
	readonly total: number;
	readonly fresh: number;
	readonly recent: number;
	readonly residual: number;
	readonly byKind: Readonly<Record<TemporalEvidenceKind, number>>;
}

export interface TemporalEvidenceSnapshot {
	readonly version: 1;
	readonly revision: number;
	readonly scopeVersion: number;
	readonly disposed: boolean;
	readonly entries: readonly TemporalEvidenceEntry[];
	readonly counters: TemporalEvidenceCounters;
}

export interface TemporalEvidenceKindPolicy {
	readonly capacity: number;
	readonly freshForMs: number;
	readonly recentForMs: number;
	readonly residualForMs: number;
}

export interface TemporalEvidencePolicy {
	readonly globalCapacity: number;
	readonly kinds: Readonly<Record<TemporalEvidenceKind, TemporalEvidenceKindPolicy>>;
}

export interface TemporalEvidenceScope {
	readonly root: number;
	readonly session: number;
}

export interface TemporalEvidenceStoreOptions {
	readonly scope: TemporalEvidenceScope;
	readonly policy?: TemporalEvidencePolicy;
}

function defaultKindPolicy(): TemporalEvidenceKindPolicy {
	return Object.freeze({ capacity: 12, freshForMs: 1_000, recentForMs: 4_000, residualForMs: 15_000 });
}

const DEFAULT_KIND_POLICIES = Object.fromEntries(
	TEMPORAL_EVIDENCE_KINDS.map(kind => [kind, defaultKindPolicy()]),
) as Record<TemporalEvidenceKind, TemporalEvidenceKindPolicy>;

export const DEFAULT_TEMPORAL_EVIDENCE_POLICY: TemporalEvidencePolicy = Object.freeze({
	globalCapacity: 96,
	kinds: Object.freeze(DEFAULT_KIND_POLICIES),
});

interface StoredEvidence {
	kind: TemporalEvidenceKind;
	slot: number;
	observedAt: number;
	payload: TemporalEvidencePayload;
	payloadSignature: string;
	freshUntil: number;
	recentUntil: number;
	expiresAt: number;
	sequence: number;
	publishedStage: TemporalEvidenceStage | undefined;
	publishedEntry: TemporalEvidenceEntry | undefined;
}

function isNonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function assertScope(scope: TemporalEvidenceScope): void {
	if (
		!Number.isSafeInteger(scope.root) ||
		scope.root < 0 ||
		!Number.isSafeInteger(scope.session) ||
		scope.session < 0
	) {
		throw new RangeError("Temporal evidence scope must use non-negative safe integers");
	}
}

function copyPolicy(policy: TemporalEvidencePolicy): TemporalEvidencePolicy {
	if (!Number.isSafeInteger(policy.globalCapacity) || policy.globalCapacity < 1) {
		throw new RangeError("Temporal evidence global capacity must be a positive safe integer");
	}
	const kinds = {} as Record<TemporalEvidenceKind, TemporalEvidenceKindPolicy>;
	for (const kind of TEMPORAL_EVIDENCE_KINDS) {
		const candidate = policy.kinds[kind];
		if (!Number.isSafeInteger(candidate.capacity) || candidate.capacity < 1) {
			throw new RangeError(`Temporal evidence capacity is invalid for ${kind}`);
		}
		if (
			!isNonNegativeFinite(candidate.freshForMs) ||
			!isNonNegativeFinite(candidate.recentForMs) ||
			!isNonNegativeFinite(candidate.residualForMs)
		) {
			throw new RangeError(`Temporal evidence TTL is invalid for ${kind}`);
		}
		kinds[kind] = Object.freeze({ ...candidate });
	}
	return Object.freeze({ globalCapacity: policy.globalCapacity, kinds: Object.freeze(kinds) });
}

function payloadRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
	return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function finiteNumber(value: unknown, minimum = 0, maximum = Number.POSITIVE_INFINITY): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
		? value
		: undefined;
}

function normalizeTemporalEvidencePayload(
	kind: TemporalEvidenceKind,
	payload: unknown,
): TemporalEvidencePayload | undefined {
	const value = payloadRecord(payload);
	if (value === undefined) return undefined;
	switch (kind) {
		case "memory-observation": {
			const status = enumValue(value.status, ["available", "degraded", "unavailable"] as const);
			const tier = enumValue(value.tier, ["local", "remote", "hybrid", "unknown"] as const);
			return status === undefined || tier === undefined ? undefined : Object.freeze({ status, tier });
		}
		case "causal-relation": {
			const relation = enumValue(value.relation, ["causes", "blocks", "unblocks", "supersedes"] as const);
			const strength = finiteNumber(value.strength, 0, 1);
			return relation === undefined || strength === undefined ? undefined : Object.freeze({ relation, strength });
		}
		case "freshness-transition": {
			const from = enumValue(value.from, ["fresh", "recent", "residual", "absent"] as const);
			const to = enumValue(value.to, ["fresh", "recent", "residual", "absent"] as const);
			return from === undefined || to === undefined ? undefined : Object.freeze({ from, to });
		}
		case "progress-observation": {
			const completed = safeInteger(value.completed);
			const total = safeInteger(value.total);
			return completed === undefined || total === undefined || completed > total
				? undefined
				: Object.freeze({ completed, total });
		}
		case "retry-schedule": {
			const attempt = safeInteger(value.attempt, 1);
			const delayMs = finiteNumber(value.delayMs);
			return attempt === undefined || delayMs === undefined ? undefined : Object.freeze({ attempt, delayMs });
		}
		case "cancellation-relation": {
			const phase = enumValue(value.phase, ["requested", "acknowledged", "completed"] as const);
			const relatedSlot = safeInteger(value.relatedSlot);
			return phase === undefined || relatedSlot === undefined ? undefined : Object.freeze({ phase, relatedSlot });
		}
		case "skill-invocation": {
			const phase = enumValue(value.phase, ["started", "completed", "failed"] as const);
			const source = enumValue(value.source, ["managed", "user", "builtin", "unknown"] as const);
			return phase === undefined || source === undefined ? undefined : Object.freeze({ phase, source });
		}
		case "latency-sample": {
			const durationMs = finiteNumber(value.durationMs);
			const phase = enumValue(value.phase, ["first-byte", "completion", "queue", "unknown"] as const);
			return durationMs === undefined || phase === undefined ? undefined : Object.freeze({ durationMs, phase });
		}
		case "cache-outcome": {
			const outcome = enumValue(value.outcome, ["hit", "miss", "bypass"] as const);
			const savedTokens = safeInteger(value.savedTokens);
			return outcome === undefined || savedTokens === undefined
				? undefined
				: Object.freeze({ outcome, savedTokens });
		}
		case "signal-collision": {
			const count = safeInteger(value.count, 1);
			const resolution = enumValue(value.resolution, ["coalesced", "dropped", "deferred"] as const);
			return count === undefined || resolution === undefined ? undefined : Object.freeze({ count, resolution });
		}
		case "numeric-history": {
			const numeric = typeof value.value === "number" && Number.isFinite(value.value) ? value.value : undefined;
			const series = enumValue(value.series, ["rate", "count", "ratio", "duration"] as const);
			return numeric === undefined || series === undefined ? undefined : Object.freeze({ value: numeric, series });
		}
	}
}

function payloadSignature<K extends TemporalEvidenceKind>(kind: K, payload: TemporalEvidencePayload<K>): string {
	switch (kind) {
		case "memory-observation": {
			const value = payload as TemporalEvidencePayload<"memory-observation">;
			return `${value.status}|${value.tier}`;
		}
		case "causal-relation": {
			const value = payload as TemporalEvidencePayload<"causal-relation">;
			return `${value.relation}|${value.strength}`;
		}
		case "freshness-transition": {
			const value = payload as TemporalEvidencePayload<"freshness-transition">;
			return `${value.from}|${value.to}`;
		}
		case "progress-observation": {
			const value = payload as TemporalEvidencePayload<"progress-observation">;
			return `${value.completed}|${value.total}`;
		}
		case "retry-schedule": {
			const value = payload as TemporalEvidencePayload<"retry-schedule">;
			return `${value.attempt}|${value.delayMs}`;
		}
		case "cancellation-relation": {
			const value = payload as TemporalEvidencePayload<"cancellation-relation">;
			return `${value.phase}|${value.relatedSlot}`;
		}
		case "skill-invocation": {
			const value = payload as TemporalEvidencePayload<"skill-invocation">;
			return `${value.phase}|${value.source}`;
		}
		case "latency-sample": {
			const value = payload as TemporalEvidencePayload<"latency-sample">;
			return `${value.durationMs}|${value.phase}`;
		}
		case "cache-outcome": {
			const value = payload as TemporalEvidencePayload<"cache-outcome">;
			return `${value.outcome}|${value.savedTokens}`;
		}
		case "signal-collision": {
			const value = payload as TemporalEvidencePayload<"signal-collision">;
			return `${value.count}|${value.resolution}`;
		}
		case "numeric-history": {
			const value = payload as TemporalEvidencePayload<"numeric-history">;
			return `${value.value}|${value.series}`;
		}
	}
}

function stageAt(entry: StoredEvidence, now: number): TemporalEvidenceStage {
	if (now < entry.freshUntil) return "fresh";
	if (now < entry.recentUntil) return "recent";
	return "residual";
}

function emptyKindCounts(): Record<TemporalEvidenceKind, number> {
	const counts = {} as Record<TemporalEvidenceKind, number>;
	for (const kind of TEMPORAL_EVIDENCE_KINDS) counts[kind] = 0;
	return counts;
}

function freezeCounters(
	total: number,
	fresh: number,
	recent: number,
	residual: number,
	byKind: Record<TemporalEvidenceKind, number>,
): TemporalEvidenceCounters {
	return Object.freeze({ total, fresh, recent, residual, byKind: Object.freeze(byKind) });
}

function frozenSnapshot(revision: number, scopeVersion: number, disposed: boolean): TemporalEvidenceSnapshot {
	const entries = Object.freeze([]) as readonly TemporalEvidenceEntry[];
	return Object.freeze({
		version: 1,
		revision,
		scopeVersion,
		disposed,
		entries,
		counters: freezeCounters(0, 0, 0, 0, emptyKindCounts()),
	});
}

/** A bounded, caller-clocked evidence store whose scope keys never leave the store. */
export class TemporalEvidenceStore {
	readonly #policy: TemporalEvidencePolicy;
	#root: number;
	#session: number;
	#scopeVersion = 0;
	#sequence = 0;
	#revision = 0;
	#lastSnapshotNow = Number.NEGATIVE_INFINITY;
	#entries: StoredEvidence[] = [];
	#snapshot: TemporalEvidenceSnapshot;
	#dirty = false;
	#disposed = false;

	constructor(options: TemporalEvidenceStoreOptions) {
		assertScope(options.scope);
		this.#policy = copyPolicy(options.policy ?? DEFAULT_TEMPORAL_EVIDENCE_POLICY);
		this.#root = options.scope.root;
		this.#session = options.scope.session;
		this.#snapshot = frozenSnapshot(this.#revision, this.#scopeVersion, false);
	}

	observe<K extends TemporalEvidenceKind>(input: TemporalEvidenceInput<K>): boolean {
		if (this.#disposed) return false;
		if (!Number.isSafeInteger(input.slot) || input.slot < 0 || !isNonNegativeFinite(input.observedAt)) {
			throw new RangeError("Temporal evidence slot and observation time must be non-negative finite values");
		}
		const payload = normalizeTemporalEvidencePayload(input.kind, input.payload);
		if (payload === undefined) throw new TypeError(`Invalid temporal evidence payload for ${input.kind}`);
		const signature = payloadSignature(input.kind, payload as TemporalEvidencePayload<K>);
		const existing = this.#entries.find(entry => entry.kind === input.kind && entry.slot === input.slot);
		if (existing !== undefined) {
			if (input.observedAt < existing.observedAt) return false;
			if (input.observedAt === existing.observedAt && signature === existing.payloadSignature) return false;
			const isNewer = input.observedAt > existing.observedAt;
			const policy = this.#policy.kinds[input.kind];
			existing.observedAt = input.observedAt;
			existing.payload = payload;
			existing.payloadSignature = signature;
			if (isNewer) {
				existing.freshUntil = input.observedAt + policy.freshForMs;
				existing.recentUntil = existing.freshUntil + policy.recentForMs;
				existing.expiresAt = existing.recentUntil + policy.residualForMs;
			}
			existing.publishedStage = undefined;
			existing.publishedEntry = undefined;
			this.#dirty = true;
			return true;
		}

		const policy = this.#policy.kinds[input.kind];
		const freshUntil = input.observedAt + policy.freshForMs;
		const recentUntil = freshUntil + policy.recentForMs;
		const added: StoredEvidence = {
			kind: input.kind,
			slot: input.slot,
			observedAt: input.observedAt,
			payload,
			payloadSignature: signature,
			freshUntil,
			recentUntil,
			expiresAt: recentUntil + policy.residualForMs,
			sequence: this.#sequence++,
			publishedStage: undefined,
			publishedEntry: undefined,
		};
		this.#entries.push(added);
		this.#trimKind(input.kind, policy.capacity);
		this.#trimGlobal();
		if (!this.#entries.includes(added)) return false;
		this.#dirty = true;
		return true;
	}

	switchScope(scope: TemporalEvidenceScope): boolean {
		if (this.#disposed) return false;
		assertScope(scope);
		if (scope.root === this.#root && scope.session === this.#session) return false;
		this.#root = scope.root;
		this.#session = scope.session;
		this.#scopeVersion++;
		this.#entries = [];
		this.#dirty = true;
		return true;
	}

	snapshot(now: number): TemporalEvidenceSnapshot {
		if (this.#disposed) return this.#snapshot;
		if (!isNonNegativeFinite(now)) {
			throw new RangeError("Temporal evidence snapshot time must be a non-negative finite number");
		}
		let changed = this.#dirty;
		if (now < this.#lastSnapshotNow) {
			// The shared clock is wall-clock epoch ms (see FrameScheduler), which
			// steps backward on NTP correction or sleep/wake. Real elapsed time did
			// not move backward, so shift every entry by the step to keep its age;
			// throwing here would surface as an uncaught exception in the host's
			// frame timer and take the whole session down.
			const step = this.#lastSnapshotNow - now;
			for (const entry of this.#entries) {
				entry.observedAt -= step;
				entry.freshUntil -= step;
				entry.recentUntil -= step;
				entry.expiresAt -= step;
				entry.publishedEntry = undefined;
			}
			if (this.#entries.length > 0) changed = true;
		}
		this.#lastSnapshotNow = now;
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index];
			if (now >= entry.expiresAt) {
				this.#entries.splice(index, 1);
				changed = true;
				continue;
			}
			const stage = stageAt(entry, now);
			if (stage !== entry.publishedStage) changed = true;
		}
		if (!changed) return this.#snapshot;

		const entries: TemporalEvidenceEntry[] = [];
		const byKind = emptyKindCounts();
		let fresh = 0;
		let recent = 0;
		let residual = 0;
		for (const stored of this.#entries) {
			const stage = stageAt(stored, now);
			stored.publishedStage = stage;
			byKind[stored.kind]++;
			switch (stage) {
				case "fresh":
					fresh++;
					break;
				case "recent":
					recent++;
					break;
				case "residual":
					residual++;
					break;
			}
			let published = stored.publishedEntry;
			if (published === undefined || published.stage !== stage) {
				published = Object.freeze({
					kind: stored.kind,
					slot: stored.slot,
					observedAt: stored.observedAt,
					payload: stored.payload,
					stage,
					freshUntil: stored.freshUntil,
					recentUntil: stored.recentUntil,
					expiresAt: stored.expiresAt,
				}) as TemporalEvidenceEntry;
				stored.publishedEntry = published;
			}
			entries.push(published);
		}
		const frozenEntries = Object.freeze(entries) as readonly TemporalEvidenceEntry[];
		this.#snapshot = Object.freeze({
			version: 1,
			revision: ++this.#revision,
			scopeVersion: this.#scopeVersion,
			disposed: false,
			entries: frozenEntries,
			counters: freezeCounters(frozenEntries.length, fresh, recent, residual, byKind),
		});
		this.#dirty = false;
		return this.#snapshot;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#entries = [];
		this.#dirty = false;
		this.#snapshot = frozenSnapshot(++this.#revision, this.#scopeVersion, true);
	}

	#trimKind(kind: TemporalEvidenceKind, capacity: number): void {
		while (this.#countKind(kind) > capacity) {
			const index = this.#oldestIndex(kind);
			if (index < 0) return;
			this.#entries.splice(index, 1);
		}
	}

	#trimGlobal(): void {
		while (this.#entries.length > this.#policy.globalCapacity) {
			const index = this.#oldestIndex();
			if (index < 0) return;
			this.#entries.splice(index, 1);
		}
	}

	#countKind(kind: TemporalEvidenceKind): number {
		let count = 0;
		for (const entry of this.#entries) if (entry.kind === kind) count++;
		return count;
	}

	#oldestIndex(kind?: TemporalEvidenceKind): number {
		let oldest = -1;
		for (let index = 0; index < this.#entries.length; index++) {
			const candidate = this.#entries[index];
			if (kind !== undefined && candidate.kind !== kind) continue;
			if (
				oldest < 0 ||
				candidate.observedAt < this.#entries[oldest].observedAt ||
				(candidate.observedAt === this.#entries[oldest].observedAt &&
					candidate.sequence < this.#entries[oldest].sequence)
			) {
				oldest = index;
			}
		}
		return oldest;
	}
}
