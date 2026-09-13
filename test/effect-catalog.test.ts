import { describe, expect, test } from "bun:test";
import {
	EFFECT_CATALOG,
	EFFECT_SAFE_FIELDS,
	type EffectAuthoritativeSource,
	type EffectCatalogEntry,
	type EffectSafeField,
	SIGNAL_EFFECT_IDS,
	validateEffectCatalog,
} from "../src/animations-box/effect-catalog";
import { TEMPORAL_EVIDENCE_KINDS, type TemporalEvidenceKind } from "../src/animations-box/temporal-evidence";

const firstAllowed = (): EffectCatalogEntry => {
	const entry = EFFECT_CATALOG.find(candidate => candidate.allowed);
	if (entry === undefined) throw new Error("catalog has no allowed effects");
	return entry;
};

const violationIds = (entries: readonly EffectCatalogEntry[]): string[] =>
	validateEffectCatalog(entries).map(violation => violation.id);

describe("signal-effect ownership catalog", () => {
	test("is exhaustive, internally valid, and covers every shared evidence kind", () => {
		expect(EFFECT_CATALOG.map(entry => entry.id)).toEqual([...SIGNAL_EFFECT_IDS]);
		expect(validateEffectCatalog(EFFECT_CATALOG)).toEqual([]);

		const coveredKinds = [...new Set(EFFECT_CATALOG.flatMap(entry => entry.safeEvidenceKinds))].sort();
		expect(coveredKinds).toEqual([...TEMPORAL_EVIDENCE_KINDS].sort());
	});

	test("allows only unique plugin-owned questions on unique existing surfaces", () => {
		const entry = firstAllowed();
		const duplicateSurface = { ...entry, id: "freshness-afterglow" } satisfies EffectCatalogEntry;
		const duplicateQuestion = {
			...EFFECT_CATALOG.find(candidate => candidate.id === "freshness-afterglow")!,
			question: entry.question,
		} satisfies EffectCatalogEntry;
		const missingQuestion = { ...entry, question: null } satisfies EffectCatalogEntry;

		expect(violationIds([entry, duplicateSurface])).toContain("duplicate-surface");
		expect(violationIds([entry, duplicateQuestion])).toContain("duplicate-question");
		expect(violationIds([missingQuestion])).toContain("missing-question");
	});

	test("rejects unsafe sources, fields, and unregistered evidence kinds", () => {
		const entry = firstAllowed();
		const unsafeSource = {
			...entry,
			authoritativeSource: "raw-host-input" as unknown as EffectAuthoritativeSource,
		} satisfies EffectCatalogEntry;
		const unsafeField = {
			...entry,
			retainedFields: ["prompt"] as unknown as readonly EffectSafeField[],
		} satisfies EffectCatalogEntry;
		const unsafeKind = {
			...entry,
			safeEvidenceKinds: ["tool-output"] as unknown as readonly TemporalEvidenceKind[],
		} satisfies EffectCatalogEntry;

		expect(violationIds([unsafeSource])).toContain("unsafe-source");
		expect(violationIds([unsafeField])).toContain("unsafe-field");
		expect(violationIds([unsafeKind])).toContain("unregistered-evidence-kind");
		expect(EFFECT_SAFE_FIELDS).not.toContain("prompt");
		expect(EFFECT_SAFE_FIELDS).not.toContain("query");
		expect(EFFECT_SAFE_FIELDS).not.toContain("path");
		expect(EFFECT_SAFE_FIELDS).not.toContain("content");
		expect(EFFECT_SAFE_FIELDS).not.toContain("toolArgs");
		expect(EFFECT_SAFE_FIELDS).not.toContain("toolOutput");
		expect(EFFECT_SAFE_FIELDS).not.toContain("errorMessage");
	});

	test("requires fixed capacity, TTL, and ordered semantic stage bounds", () => {
		const entry = firstAllowed();
		const noCapacity = { ...entry, capacity: 0 } satisfies EffectCatalogEntry;
		const noTtl = { ...entry, ttlMs: 0 } satisfies EffectCatalogEntry;
		const unorderedStages = {
			...entry,
			stages: { freshUntilMs: 2_000, recentUntilMs: 1_000, residualUntilMs: entry.ttlMs },
		} satisfies EffectCatalogEntry;

		expect(violationIds([noCapacity])).toContain("unbounded-retention");
		expect(violationIds([noTtl])).toContain("unbounded-retention");
		expect(violationIds([unorderedStages])).toContain("unbounded-retention");
	});

	test("rejects independent scheduling, storage, and surface claims", () => {
		const entry = firstAllowed();
		const independentScheduler = {
			...entry,
			scheduler: "row-timer" as unknown as "animation-host",
		} satisfies EffectCatalogEntry;
		const independentStore = {
			...entry,
			evidenceStore: "feature-history" as unknown as "temporal-evidence",
		} satisfies EffectCatalogEntry;
		const newSurface = { ...entry, createsSurface: true as unknown as false } satisfies EffectCatalogEntry;
		const statefulRenderer = { ...entry, projectionOnly: false } satisfies EffectCatalogEntry;

		expect(violationIds([independentScheduler])).toContain("independent-scheduler");
		expect(violationIds([independentStore])).toContain("independent-store");
		expect(violationIds([newSurface])).toContain("creates-surface");
		expect(violationIds([statefulRenderer])).toContain("non-projection-effect");
	});

	test("keeps every OMP-owned equivalent explicitly forbidden", () => {
		const hostEntries = EFFECT_CATALOG.filter(entry => entry.owner === "omp-host");
		expect(hostEntries.length).toBeGreaterThan(0);
		expect(hostEntries.every(entry => !entry.allowed && entry.question === null)).toBe(true);

		const illegallyAllowed = { ...hostEntries[0]!, allowed: true } satisfies EffectCatalogEntry;
		expect(violationIds([illegallyAllowed])).toContain("allowed-host-effect");
	});
});
