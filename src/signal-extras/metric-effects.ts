const DURATION_CAPACITY = 8;
const CACHE_OUTCOME_CAPACITY = 8;
const MIN_COMPARABLE_SAMPLES = 5;
const MAX_COALESCED_COUNT = 99;
const NARROW_WIDTH = 32;
const DIFFRACTION_STAGE_MS = 200;
const DIFFRACTION_STATIC_MS = 600;
const DIFFRACTION_TTL_MS = 1_200;

export const METRIC_OPERATION_CLASSES = ["ttft", "provider-request", "tool-call", "cache-lookup"] as const;
export type MetricOperationClass = (typeof METRIC_OPERATION_CLASSES)[number];

export interface DurationSample {
	readonly operationClass: MetricOperationClass;
	readonly durationMs: number;
}

export interface DurationQuantization {
	readonly operationClass: MetricOperationClass;
	readonly levels: readonly number[];
	readonly comparison: "faster" | "typical" | "slower";
	readonly sampleCount: number;
}

function isMetricOperationClass(value: unknown): value is MetricOperationClass {
	return typeof value === "string" && (METRIC_OPERATION_CLASSES as readonly string[]).includes(value);
}

function isFiniteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Appends one safe numeric sample without retaining caller-provided keys. */
export function appendDurationSample(
	history: readonly DurationSample[],
	candidate: { readonly operationClass: unknown; readonly durationMs: unknown },
): readonly DurationSample[] {
	if (!isMetricOperationClass(candidate.operationClass) || !isFiniteNonnegative(candidate.durationMs)) return history;
	const retained =
		history.length >= DURATION_CAPACITY ? history.slice(history.length - DURATION_CAPACITY + 1) : history;
	return [...retained, { operationClass: candidate.operationClass, durationMs: candidate.durationMs }];
}

function median(sorted: readonly number[]): number {
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/**
 * Produces bounded relative ticks only when the complete retained window is
 * finite, allowlisted, and comparable. Claims use the prior-window median and
 * a noise floor, so small differences cannot be promoted to faster/slower.
 */
export function quantizeDurationSamples(samples: readonly DurationSample[]): DurationQuantization | undefined {
	const window = samples.slice(-DURATION_CAPACITY);
	if (window.length < MIN_COMPARABLE_SAMPLES) return undefined;
	const operationClass = window[0]?.operationClass;
	if (!isMetricOperationClass(operationClass)) return undefined;

	const values: number[] = [];
	for (const sample of window) {
		if (sample.operationClass !== operationClass || !isFiniteNonnegative(sample.durationMs)) return undefined;
		values.push(sample.durationMs);
	}

	const prior = values.slice(0, -1).sort((left, right) => left - right);
	const baseline = median(prior);
	const deviations = prior.map(value => Math.abs(value - baseline)).sort((left, right) => left - right);
	const medianDeviation = median(deviations);
	const scale = Math.max(50, baseline * 0.1, medianDeviation * 3);
	const lower = Math.max(0, baseline - scale * 2);
	const upper = baseline + scale * 2;
	const span = Math.max(1, upper - lower);
	const levels = values.map(value => Math.max(0, Math.min(4, Math.round(((value - lower) / span) * 4))));

	const newest = values[values.length - 1] ?? baseline;
	const claimThreshold = Math.max(50, baseline * 0.15, medianDeviation * 3);
	const comparison =
		newest > baseline + claimThreshold ? "slower" : newest < baseline - claimThreshold ? "faster" : "typical";

	return { operationClass, levels, comparison, sampleCount: values.length };
}

export const CACHE_LAYERS = ["provider", "provider-prompt"] as const;
export type CacheLayer = (typeof CACHE_LAYERS)[number];

export const CACHE_LOOKUP_CLASSES = ["prompt-prefix", "system-tools", "conversation-prefix", "turn-tail"] as const;
export type CacheLookupClass = (typeof CACHE_LOOKUP_CLASSES)[number];

export const CACHE_DISPOSITIONS = ["reused", "missed", "bypassed"] as const;
export type CacheDisposition = (typeof CACHE_DISPOSITIONS)[number];

export interface CacheOutcomeObservation {
	readonly layer: unknown;
	readonly lookupClass: unknown;
	readonly disposition: unknown;
	readonly cacheRead: unknown;
	readonly cacheWrite: unknown;
	readonly uncached: unknown;
	readonly measuredSavingsMs?: unknown;
}

export interface CacheOutcomeTuple {
	readonly layer: CacheLayer;
	readonly lookupClass: CacheLookupClass;
	readonly disposition: CacheDisposition;
	readonly compared: number;
	readonly reused: number;
	readonly missed: number;
	readonly bypassed: number;
	readonly stored: number;
	readonly measuredSavingsMs?: number;
}

function isCacheLayer(value: unknown): value is CacheLayer {
	return typeof value === "string" && (CACHE_LAYERS as readonly string[]).includes(value);
}

function isCacheLookupClass(value: unknown): value is CacheLookupClass {
	return typeof value === "string" && (CACHE_LOOKUP_CLASSES as readonly string[]).includes(value);
}

function isCacheDisposition(value: unknown): value is CacheDisposition {
	return typeof value === "string" && (CACHE_DISPOSITIONS as readonly string[]).includes(value);
}

function isQuantity(value: unknown): value is number {
	return isFiniteNonnegative(value) && Number.isSafeInteger(value);
}

/** Builds an explanatory cache tuple only from an explicit authoritative disposition. */
export function buildCacheOutcome(observation: CacheOutcomeObservation): CacheOutcomeTuple | undefined {
	if (
		!isCacheLayer(observation.layer) ||
		!isCacheLookupClass(observation.lookupClass) ||
		!isCacheDisposition(observation.disposition) ||
		!isQuantity(observation.cacheRead) ||
		!isQuantity(observation.cacheWrite) ||
		!isQuantity(observation.uncached)
	) {
		return undefined;
	}

	const { cacheRead, cacheWrite, uncached, disposition } = observation;
	if (cacheRead + cacheWrite + uncached === 0) return undefined;
	if (disposition === "reused" && cacheRead === 0) return undefined;
	if (disposition === "missed" && (cacheRead !== 0 || uncached === 0)) return undefined;
	if (disposition === "bypassed" && (cacheRead !== 0 || cacheWrite !== 0 || uncached === 0)) return undefined;

	const savings = isFiniteNonnegative(observation.measuredSavingsMs) ? observation.measuredSavingsMs : undefined;
	return {
		layer: observation.layer,
		lookupClass: observation.lookupClass,
		disposition,
		compared: disposition === "bypassed" ? 0 : cacheRead + uncached,
		reused: disposition === "reused" ? cacheRead : 0,
		missed: disposition === "bypassed" ? 0 : uncached,
		bypassed: disposition === "bypassed" ? uncached : 0,
		stored: cacheWrite,
		...(disposition === "reused" && savings !== undefined ? { measuredSavingsMs: savings } : {}),
	};
}

export function appendCacheOutcome(
	history: readonly CacheOutcomeTuple[],
	observation: CacheOutcomeObservation,
): readonly CacheOutcomeTuple[] {
	const outcome = buildCacheOutcome(observation);
	if (outcome === undefined) return history;
	const retained =
		history.length >= CACHE_OUTCOME_CAPACITY ? history.slice(history.length - CACHE_OUTCOME_CAPACITY + 1) : history;
	return [...retained, outcome];
}

export const COLLISION_SAMPLE_IDS = [
	"memoryBackendTide",
	"errorIsotope",
	"retryRadar",
	"skillChromatograph",
	"ttftSplit",
	"cacheMeter",
] as const;
export type CollisionSampleId = (typeof COLLISION_SAMPLE_IDS)[number];
export type CollisionPriority = 1 | 2 | 3;

export interface CollisionFact {
	readonly sampleId: unknown;
	readonly priority: unknown;
}

export interface CollisionFrame {
	readonly phase: "changed" | "stable" | "idle";
	readonly observedAt: number;
	readonly facts: readonly CollisionFact[];
}

export interface CollisionCapabilities {
	readonly width: number;
	readonly unicode: boolean;
	readonly color: boolean;
	readonly reducedMotion: boolean;
}

export interface CollisionDiffractionToken {
	readonly target: "border";
	readonly foreground: CollisionSampleId;
	readonly priority: CollisionPriority;
	readonly coalescedCount: number;
	readonly stage: 1 | 2 | 3 | "static";
	readonly fringe: string;
}

function isCollisionSampleId(value: unknown): value is CollisionSampleId {
	return typeof value === "string" && (COLLISION_SAMPLE_IDS as readonly string[]).includes(value);
}

function isCollisionPriority(value: unknown): value is CollisionPriority {
	return value === 1 || value === 2 || value === 3;
}

const UNICODE_FRINGES = ["··╾◇◆◇╼··", "···╾◆╼···", "····◆····"] as const;
const ASCII_FRINGES = ["..<.*.>..", "...<*>...", "....*...."] as const;

/** Composes one finite token from plugin-owned facts in one immutable frame. */
export function composeCollisionDiffraction(
	frame: CollisionFrame,
	now: number,
	capabilities: CollisionCapabilities,
): CollisionDiffractionToken | undefined {
	if (
		frame.phase !== "changed" ||
		capabilities.reducedMotion ||
		!Number.isFinite(capabilities.width) ||
		capabilities.width < NARROW_WIDTH ||
		!Number.isFinite(frame.observedAt) ||
		!Number.isFinite(now)
	) {
		return undefined;
	}

	let foreground: CollisionSampleId | undefined;
	let priority: CollisionPriority | undefined;
	let factCount = 0;
	for (const fact of frame.facts) {
		if (!isCollisionSampleId(fact.sampleId) || !isCollisionPriority(fact.priority)) continue;
		factCount++;
		if (
			priority === undefined ||
			fact.priority < priority ||
			(fact.priority === priority &&
				COLLISION_SAMPLE_IDS.indexOf(fact.sampleId) < COLLISION_SAMPLE_IDS.indexOf(foreground!))
		) {
			foreground = fact.sampleId;
			priority = fact.priority;
		}
	}
	if (factCount < 2 || foreground === undefined || priority === undefined) return undefined;

	const age = now - frame.observedAt;
	if (age < 0 || age >= DIFFRACTION_TTL_MS) return undefined;
	const coalescedCount = Math.min(MAX_COALESCED_COUNT, factCount - 1);
	if (age >= DIFFRACTION_STATIC_MS) {
		return {
			target: "border",
			foreground,
			priority,
			coalescedCount,
			stage: "static",
			fringe: `...+${String(coalescedCount).padStart(2, "0")}...`,
		};
	}

	const stageIndex = Math.min(2, Math.floor(age / DIFFRACTION_STAGE_MS));
	const fringes = capabilities.unicode ? UNICODE_FRINGES : ASCII_FRINGES;
	return {
		target: "border",
		foreground,
		priority,
		coalescedCount,
		stage: (stageIndex + 1) as 1 | 2 | 3,
		fringe: fringes[stageIndex]!,
	};
}
