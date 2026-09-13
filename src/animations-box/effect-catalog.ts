import { TEMPORAL_EVIDENCE_KINDS, type TemporalEvidenceKind, type TemporalEvidenceStage } from "./temporal-evidence";

export const SIGNAL_EFFECT_IDS = [
	"memory-backend-tide-ii",
	"causal-handoff-threads",
	"freshness-afterglow",
	"progress-confidence-rail",
	"retry-backoff-fuse",
	"cancellation-sweep",
	"skill-invocation-chain",
	"latency-echo-ticks",
	"cache-outcome-ledger",
	"signal-collision-diffraction",
	"provenance-topology-ink",
	"multiscale-event-dither",
	"host-prompt-copy",
	"host-progress-row",
	"host-error-row",
	"host-action-control",
	"host-notification",
	"host-navigation",
	"host-title-projection",
	"host-instrumentation",
] as const;

export type SignalEffectId = (typeof SIGNAL_EFFECT_IDS)[number];
export type EffectOwner = "box-required" | "box-extra" | "plugin-chrome" | "omp-host";
export type EffectStage = TemporalEvidenceStage;

export const EFFECT_AUTHORITATIVE_SOURCES = [
	"memory-status-adapter",
	"exact-plugin-relation",
	"sanitized-frame-transition",
	"agent-bonsai-progress",
	"retry-radar-state",
	"activity-roster",
	"skill-tool-lifecycle",
	"ttft-split-state",
	"cache-meter-state",
	"immutable-frame-snapshot",
	"recurrence-state",
	"tool-activity-state",
	"omp-host",
] as const;

export type EffectAuthoritativeSource = (typeof EFFECT_AUTHORITATIVE_SOURCES)[number];

export const EFFECT_SAFE_FIELDS = [
	"backendClass",
	"capabilityClass",
	"scopeClass",
	"count",
	"observationClass",
	"relationClass",
	"outcomeClass",
	"transitionClass",
	"progressClass",
	"currentCount",
	"totalCount",
	"attemptCount",
	"maximumAttemptCount",
	"delayMs",
	"actorClass",
	"skillName",
	"durationMs",
	"cacheLayer",
	"lookupClass",
	"reusedCount",
	"missedCount",
	"bypassedCount",
	"collisionCount",
	"sampleValue",
] as const;

export type EffectSafeField = (typeof EFFECT_SAFE_FIELDS)[number];

export const FORBIDDEN_HOST_EQUIVALENTS = [
	"prompt",
	"progress",
	"error",
	"action",
	"notification",
	"navigation",
	"title",
	"instrumentation",
	"command",
] as const;

export type ForbiddenHostEquivalent = (typeof FORBIDDEN_HOST_EQUIVALENTS)[number];

export type EffectSurface =
	| "memoryBackendTide"
	| "errorIsotope"
	| "auditTrailBox"
	| "agentBonsai"
	| "retryRadar"
	| "sessionPhylogeny"
	| "skillChromatograph"
	| "ttftSplit"
	| "cacheMeter"
	| "boxBorder"
	| "recurrenceStrip"
	| "toolActivity"
	| "ompPrompt"
	| "ompProgress"
	| "ompError"
	| "ompAction"
	| "ompNotification"
	| "ompNavigation"
	| "ompTitle"
	| "ompInstrumentation";

export interface EffectStageBounds {
	freshUntilMs: number;
	recentUntilMs: number;
	residualUntilMs: number;
}

export interface EffectCatalogEntry {
	id: SignalEffectId;
	owner: EffectOwner;
	allowed: boolean;
	existingSurface: EffectSurface;
	projectionOnly: boolean;
	authoritativeSource: EffectAuthoritativeSource;
	retainedFields: readonly EffectSafeField[];
	safeEvidenceKinds: readonly TemporalEvidenceKind[];
	capacity: number;
	ttlMs: number;
	stages: EffectStageBounds;
	widthForm: "fixed-width" | "compact-or-hidden" | "count-only";
	reducedMotionForm: "static-final" | "static-age" | "static-count" | "hidden";
	governorPriority: "semantic" | "structural" | "cosmetic";
	forbiddenHostEquivalents: readonly ForbiddenHostEquivalent[];
	scheduler: "animation-host";
	evidenceStore: "temporal-evidence";
	createsSurface: false;
	question: string | null;
}

const BASE_POLICY = {
	projectionOnly: true,
	widthForm: "compact-or-hidden",
	reducedMotionForm: "static-final",
	scheduler: "animation-host",
	evidenceStore: "temporal-evidence",
	createsSurface: false,
} as const;

const FORBIDDEN_POLICY = {
	owner: "omp-host",
	allowed: false,
	projectionOnly: false,
	authoritativeSource: "omp-host",
	retainedFields: [],
	safeEvidenceKinds: [],
	capacity: 0,
	ttlMs: 0,
	stages: { freshUntilMs: 0, recentUntilMs: 0, residualUntilMs: 0 },
	widthForm: "compact-or-hidden",
	reducedMotionForm: "hidden",
	governorPriority: "semantic",
	scheduler: "animation-host",
	evidenceStore: "temporal-evidence",
	createsSurface: false,
	question: null,
} as const;

export const EFFECT_CATALOG_BY_ID = {
	"memory-backend-tide-ii": {
		...BASE_POLICY,
		id: "memory-backend-tide-ii",
		owner: "box-extra",
		allowed: true,
		existingSurface: "memoryBackendTide",
		authoritativeSource: "memory-status-adapter",
		retainedFields: ["backendClass", "capabilityClass", "scopeClass", "count", "observationClass"],
		safeEvidenceKinds: ["memory-observation", "freshness-transition"],
		capacity: 8,
		ttlMs: 12_000,
		stages: { freshUntilMs: 1_500, recentUntilMs: 5_000, residualUntilMs: 12_000 },
		reducedMotionForm: "static-age",
		governorPriority: "semantic",
		forbiddenHostEquivalents: ["prompt", "error", "instrumentation"],
		question: "Is the plugin-observed memory backend usable, fresh, and structurally changed?",
	},
	"causal-handoff-threads": {
		...BASE_POLICY,
		id: "causal-handoff-threads",
		owner: "box-extra",
		allowed: true,
		existingSurface: "errorIsotope",
		authoritativeSource: "exact-plugin-relation",
		retainedFields: ["relationClass", "outcomeClass"],
		safeEvidenceKinds: ["causal-relation"],
		capacity: 12,
		ttlMs: 8_000,
		stages: { freshUntilMs: 900, recentUntilMs: 3_000, residualUntilMs: 8_000 },
		governorPriority: "semantic",
		forbiddenHostEquivalents: ["error", "progress", "notification"],
		question: "Which explicitly related plugin incidents just handed off to a known outcome?",
	},
	"freshness-afterglow": {
		...BASE_POLICY,
		id: "freshness-afterglow",
		owner: "box-required",
		allowed: true,
		existingSurface: "auditTrailBox",
		authoritativeSource: "sanitized-frame-transition",
		retainedFields: ["transitionClass"],
		safeEvidenceKinds: ["freshness-transition"],
		capacity: 6,
		ttlMs: 4_000,
		stages: { freshUntilMs: 600, recentUntilMs: 1_800, residualUntilMs: 4_000 },
		governorPriority: "cosmetic",
		forbiddenHostEquivalents: ["notification", "progress"],
		question: "Which existing plugin summary changed recently without changing its meaning?",
	},
	"progress-confidence-rail": {
		...BASE_POLICY,
		id: "progress-confidence-rail",
		owner: "box-extra",
		allowed: true,
		existingSurface: "agentBonsai",
		authoritativeSource: "agent-bonsai-progress",
		retainedFields: ["progressClass", "currentCount", "totalCount"],
		safeEvidenceKinds: ["progress-observation"],
		capacity: 8,
		ttlMs: 6_000,
		stages: { freshUntilMs: 800, recentUntilMs: 2_500, residualUntilMs: 6_000 },
		widthForm: "count-only",
		reducedMotionForm: "static-count",
		governorPriority: "structural",
		forbiddenHostEquivalents: ["progress", "action"],
		question: "How strong is the evidence behind progress already shown by Agent Bonsai?",
	},
	"retry-backoff-fuse": {
		...BASE_POLICY,
		id: "retry-backoff-fuse",
		owner: "box-extra",
		allowed: true,
		existingSurface: "retryRadar",
		authoritativeSource: "retry-radar-state",
		retainedFields: ["attemptCount", "maximumAttemptCount", "delayMs", "outcomeClass"],
		safeEvidenceKinds: ["retry-schedule"],
		capacity: 8,
		ttlMs: 10_000,
		stages: { freshUntilMs: 1_000, recentUntilMs: 4_000, residualUntilMs: 10_000 },
		widthForm: "count-only",
		reducedMotionForm: "static-count",
		governorPriority: "semantic",
		forbiddenHostEquivalents: ["progress", "action", "notification"],
		question: "When will an authoritatively scheduled plugin retry become eligible?",
	},
	"cancellation-sweep": {
		...BASE_POLICY,
		id: "cancellation-sweep",
		owner: "box-extra",
		allowed: true,
		existingSurface: "sessionPhylogeny",
		authoritativeSource: "exact-plugin-relation",
		retainedFields: ["relationClass", "outcomeClass"],
		safeEvidenceKinds: ["cancellation-relation"],
		capacity: 12,
		ttlMs: 8_000,
		stages: { freshUntilMs: 800, recentUntilMs: 3_000, residualUntilMs: 8_000 },
		governorPriority: "semantic",
		forbiddenHostEquivalents: ["action", "progress", "notification"],
		question: "Which visible plugin relation has explicitly acknowledged cancellation?",
	},
	"skill-invocation-chain": {
		...BASE_POLICY,
		id: "skill-invocation-chain",
		owner: "box-extra",
		allowed: true,
		existingSurface: "skillChromatograph",
		authoritativeSource: "skill-tool-lifecycle",
		retainedFields: ["actorClass", "skillName", "count", "outcomeClass"],
		safeEvidenceKinds: ["skill-invocation"],
		capacity: 16,
		ttlMs: 15_000,
		stages: { freshUntilMs: 1_500, recentUntilMs: 6_000, residualUntilMs: 15_000 },
		widthForm: "count-only",
		reducedMotionForm: "static-count",
		governorPriority: "structural",
		forbiddenHostEquivalents: ["command", "navigation", "prompt"],
		question: "Which allowlisted skills did the same observed actor invoke in order?",
	},
	"latency-echo-ticks": {
		...BASE_POLICY,
		id: "latency-echo-ticks",
		owner: "box-extra",
		allowed: true,
		existingSurface: "ttftSplit",
		authoritativeSource: "ttft-split-state",
		retainedFields: ["durationMs", "count"],
		safeEvidenceKinds: ["latency-sample"],
		capacity: 16,
		ttlMs: 20_000,
		stages: { freshUntilMs: 2_000, recentUntilMs: 8_000, residualUntilMs: 20_000 },
		widthForm: "fixed-width",
		reducedMotionForm: "static-count",
		governorPriority: "cosmetic",
		forbiddenHostEquivalents: ["instrumentation", "progress"],
		question: "How does a bounded set of comparable plugin latency samples cluster?",
	},
	"cache-outcome-ledger": {
		...BASE_POLICY,
		id: "cache-outcome-ledger",
		owner: "box-required",
		allowed: true,
		existingSurface: "cacheMeter",
		authoritativeSource: "cache-meter-state",
		retainedFields: ["cacheLayer", "lookupClass", "reusedCount", "missedCount", "bypassedCount"],
		safeEvidenceKinds: ["cache-outcome"],
		capacity: 8,
		ttlMs: 12_000,
		stages: { freshUntilMs: 1_200, recentUntilMs: 5_000, residualUntilMs: 12_000 },
		widthForm: "count-only",
		reducedMotionForm: "static-count",
		governorPriority: "structural",
		forbiddenHostEquivalents: ["instrumentation", "notification"],
		question: "What authoritative cache outcome did the existing cache summary observe?",
	},
	"signal-collision-diffraction": {
		...BASE_POLICY,
		id: "signal-collision-diffraction",
		owner: "plugin-chrome",
		allowed: true,
		existingSurface: "boxBorder",
		authoritativeSource: "immutable-frame-snapshot",
		retainedFields: ["collisionCount", "transitionClass"],
		safeEvidenceKinds: ["signal-collision"],
		capacity: 4,
		ttlMs: 3_000,
		stages: { freshUntilMs: 400, recentUntilMs: 1_200, residualUntilMs: 3_000 },
		widthForm: "fixed-width",
		reducedMotionForm: "static-count",
		governorPriority: "cosmetic",
		forbiddenHostEquivalents: ["notification", "title", "action"],
		question: "How many plugin-owned facts arrived in the same immutable frame?",
	},
	"provenance-topology-ink": {
		...BASE_POLICY,
		id: "provenance-topology-ink",
		owner: "box-extra",
		allowed: true,
		existingSurface: "recurrenceStrip",
		authoritativeSource: "recurrence-state",
		retainedFields: ["relationClass", "count"],
		safeEvidenceKinds: ["causal-relation"],
		capacity: 12,
		ttlMs: 8_000,
		stages: { freshUntilMs: 800, recentUntilMs: 3_000, residualUntilMs: 8_000 },
		widthForm: "fixed-width",
		governorPriority: "structural",
		forbiddenHostEquivalents: ["navigation", "progress", "error"],
		question: "What exact plugin relation topology is proven in the current recurrence projection?",
	},
	"multiscale-event-dither": {
		...BASE_POLICY,
		id: "multiscale-event-dither",
		owner: "box-required",
		allowed: true,
		existingSurface: "toolActivity",
		authoritativeSource: "tool-activity-state",
		retainedFields: ["sampleValue", "count"],
		safeEvidenceKinds: ["numeric-history"],
		capacity: 16,
		ttlMs: 16_000,
		stages: { freshUntilMs: 1_000, recentUntilMs: 6_000, residualUntilMs: 16_000 },
		widthForm: "fixed-width",
		governorPriority: "cosmetic",
		forbiddenHostEquivalents: ["instrumentation", "progress"],
		question: "What bounded multi-horizon pattern exists in plugin-owned numeric history?",
	},
	"host-prompt-copy": {
		...FORBIDDEN_POLICY,
		id: "host-prompt-copy",
		existingSurface: "ompPrompt",
		forbiddenHostEquivalents: ["prompt"],
	},
	"host-progress-row": {
		...FORBIDDEN_POLICY,
		id: "host-progress-row",
		existingSurface: "ompProgress",
		forbiddenHostEquivalents: ["progress"],
	},
	"host-error-row": {
		...FORBIDDEN_POLICY,
		id: "host-error-row",
		existingSurface: "ompError",
		forbiddenHostEquivalents: ["error"],
	},
	"host-action-control": {
		...FORBIDDEN_POLICY,
		id: "host-action-control",
		existingSurface: "ompAction",
		forbiddenHostEquivalents: ["action"],
	},
	"host-notification": {
		...FORBIDDEN_POLICY,
		id: "host-notification",
		existingSurface: "ompNotification",
		forbiddenHostEquivalents: ["notification"],
	},
	"host-navigation": {
		...FORBIDDEN_POLICY,
		id: "host-navigation",
		existingSurface: "ompNavigation",
		forbiddenHostEquivalents: ["navigation"],
	},
	"host-title-projection": {
		...FORBIDDEN_POLICY,
		id: "host-title-projection",
		existingSurface: "ompTitle",
		forbiddenHostEquivalents: ["title"],
	},
	"host-instrumentation": {
		...FORBIDDEN_POLICY,
		id: "host-instrumentation",
		existingSurface: "ompInstrumentation",
		forbiddenHostEquivalents: ["instrumentation"],
	},
} as const satisfies Record<SignalEffectId, EffectCatalogEntry>;

export const EFFECT_CATALOG: readonly EffectCatalogEntry[] = SIGNAL_EFFECT_IDS.map(id => EFFECT_CATALOG_BY_ID[id]);

export type EffectCatalogViolationId =
	| "duplicate-surface"
	| "unsafe-source"
	| "unsafe-field"
	| "unregistered-evidence-kind"
	| "unbounded-retention"
	| "independent-scheduler"
	| "independent-store"
	| "creates-surface"
	| "non-projection-effect"
	| "allowed-host-effect"
	| "missing-question"
	| "duplicate-question"
	| "missing-host-exclusion";

export interface EffectCatalogViolation {
	id: EffectCatalogViolationId;
	effect: string;
}

export function validateEffectCatalog(entries: readonly EffectCatalogEntry[]): EffectCatalogViolation[] {
	const violations: EffectCatalogViolation[] = [];
	const surfaces = new Map<string, string>();
	const questions = new Map<string, string>();
	const sources: readonly string[] = EFFECT_AUTHORITATIVE_SOURCES;
	const fields: readonly string[] = EFFECT_SAFE_FIELDS;
	const kinds: readonly string[] = TEMPORAL_EVIDENCE_KINDS;

	for (const entry of entries) {
		if (!sources.includes(entry.authoritativeSource)) violations.push({ id: "unsafe-source", effect: entry.id });
		for (const field of entry.retainedFields) {
			if (!fields.includes(field)) violations.push({ id: "unsafe-field", effect: entry.id });
		}
		for (const kind of entry.safeEvidenceKinds) {
			if (!kinds.includes(kind)) violations.push({ id: "unregistered-evidence-kind", effect: entry.id });
		}
		if (entry.scheduler !== "animation-host") violations.push({ id: "independent-scheduler", effect: entry.id });
		if (entry.evidenceStore !== "temporal-evidence") violations.push({ id: "independent-store", effect: entry.id });
		if (entry.createsSurface) violations.push({ id: "creates-surface", effect: entry.id });
		if (entry.owner === "omp-host" && entry.allowed) violations.push({ id: "allowed-host-effect", effect: entry.id });
		if (entry.forbiddenHostEquivalents.length === 0)
			violations.push({ id: "missing-host-exclusion", effect: entry.id });

		if (!entry.allowed) continue;
		if (!entry.projectionOnly) violations.push({ id: "non-projection-effect", effect: entry.id });
		if (
			entry.capacity < 1 ||
			entry.ttlMs < 1 ||
			entry.stages.freshUntilMs < 1 ||
			entry.stages.freshUntilMs >= entry.stages.recentUntilMs ||
			entry.stages.recentUntilMs >= entry.stages.residualUntilMs ||
			entry.stages.residualUntilMs !== entry.ttlMs
		) {
			violations.push({ id: "unbounded-retention", effect: entry.id });
		}

		const surfaceOwner = surfaces.get(entry.existingSurface);
		if (surfaceOwner !== undefined) violations.push({ id: "duplicate-surface", effect: entry.id });
		else surfaces.set(entry.existingSurface, entry.id);

		if (entry.question === null || entry.question.trim().length === 0) {
			violations.push({ id: "missing-question", effect: entry.id });
		} else {
			const questionOwner = questions.get(entry.question);
			if (questionOwner !== undefined) violations.push({ id: "duplicate-question", effect: entry.id });
			else questions.set(entry.question, entry.id);
		}
	}
	return violations;
}
