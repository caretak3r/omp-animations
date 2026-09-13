import {
	TEMPORAL_EVIDENCE_KINDS,
	TEMPORAL_EVIDENCE_STAGES,
	type TemporalEvidenceEntry,
	type TemporalEvidenceInput,
	type TemporalEvidenceKind,
	type TemporalEvidencePayload,
	type TemporalEvidencePolicy,
	type TemporalEvidenceSnapshot,
	TemporalEvidenceStore,
} from "./temporal-evidence";

export const EVIDENCE_TAPE_VERSION = 1 as const;
export const EVIDENCE_FRAME_HASH_VERSION = 1 as const;
export const MAX_EVIDENCE_TAPE_STEPS = 4_096;

export type EvidenceTapeObservationStepV1 = {
	[K in TemporalEvidenceKind]: Readonly<{
		type: "observe";
		at: number;
		kind: K;
		slot: number;
		payload: TemporalEvidencePayload<K>;
	}>;
}[TemporalEvidenceKind];

export type EvidenceTapeStepV1 =
	| EvidenceTapeObservationStepV1
	| Readonly<{ type: "frame"; at: number }>
	| Readonly<{ type: "switch-root"; at: number }>
	| Readonly<{ type: "switch-session"; at: number }>
	| Readonly<{ type: "dispose"; at: number }>;

export interface EvidenceTapeV1 {
	readonly version: 1;
	readonly steps: readonly EvidenceTapeStepV1[];
}

export type EvidenceReplayAction = EvidenceTapeStepV1["type"];

export interface EvidenceReplayTransition {
	readonly step: number;
	readonly at: number;
	readonly action: EvidenceReplayAction;
	readonly tapeVersion: 1;
	readonly frameHashVersion: 1;
	readonly frameVersion: number;
	readonly frameHash: string;
	readonly snapshotRevision: number;
	readonly scopeVersion: number;
	readonly disposed: boolean;
	readonly total: number;
	readonly fresh: number;
	readonly recent: number;
	readonly residual: number;
}

export type EvidenceReplayIssue =
	| "invalid-tape"
	| "unsupported-version"
	| "too-many-steps"
	| "invalid-step"
	| "non-monotonic-time"
	| "invalid-evidence";

export type EvidenceReplayResult =
	| Readonly<{ ok: true; transitions: readonly EvidenceReplayTransition[] }>
	| Readonly<{ ok: false; issue: EvidenceReplayIssue; step?: number }>;

const TAPE_KEYS = ["version", "steps"] as const;
const SIMPLE_STEP_KEYS = ["type", "at"] as const;
const OBSERVATION_STEP_KEYS = ["type", "at", "kind", "slot", "payload"] as const;

function hasExactKeys(row: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
	const actual = Object.keys(row);
	if (actual.length !== expected.length) return false;
	for (const key of actual) if (!expected.includes(key)) return false;
	return true;
}

function isSafeTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isMember<const T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	if (typeof value !== "string") return false;
	for (const choice of choices) if (choice === value) return true;
	return false;
}

function parseObservation(row: Readonly<Record<string, unknown>>, at: number): TemporalEvidenceInput | undefined {
	if (!hasExactKeys(row, OBSERVATION_STEP_KEYS) || !isSafeCount(row.slot)) return undefined;
	if (!isMember(row.kind, TEMPORAL_EVIDENCE_KINDS)) return undefined;
	if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) return undefined;
	const payload = row.payload as Readonly<Record<string, unknown>>;
	const slot = row.slot;

	switch (row.kind) {
		case "memory-observation":
			if (
				!hasExactKeys(payload, ["status", "tier"]) ||
				!isMember(payload.status, ["available", "degraded", "unavailable"] as const) ||
				!isMember(payload.tier, ["local", "remote", "hybrid", "unknown"] as const)
			)
				return undefined;
			return { kind: row.kind, slot, observedAt: at, payload: { status: payload.status, tier: payload.tier } };
		case "causal-relation":
			if (
				!hasExactKeys(payload, ["relation", "strength"]) ||
				!isMember(payload.relation, ["causes", "blocks", "unblocks", "supersedes"] as const) ||
				!isFiniteNumber(payload.strength) ||
				payload.strength < 0 ||
				payload.strength > 1
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { relation: payload.relation, strength: payload.strength },
			};
		case "freshness-transition":
			if (
				!hasExactKeys(payload, ["from", "to"]) ||
				!(payload.from === "absent" || isMember(payload.from, TEMPORAL_EVIDENCE_STAGES)) ||
				!(payload.to === "absent" || isMember(payload.to, TEMPORAL_EVIDENCE_STAGES))
			)
				return undefined;
			return { kind: row.kind, slot, observedAt: at, payload: { from: payload.from, to: payload.to } };
		case "progress-observation":
			if (
				!hasExactKeys(payload, ["completed", "total"]) ||
				!isSafeCount(payload.completed) ||
				!isSafeCount(payload.total) ||
				payload.completed > payload.total
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { completed: payload.completed, total: payload.total },
			};
		case "retry-schedule":
			if (
				!hasExactKeys(payload, ["attempt", "delayMs"]) ||
				!isSafeCount(payload.attempt) ||
				!isSafeTime(payload.delayMs)
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { attempt: payload.attempt, delayMs: payload.delayMs },
			};
		case "cancellation-relation":
			if (
				!hasExactKeys(payload, ["phase", "relatedSlot"]) ||
				!isMember(payload.phase, ["requested", "acknowledged", "completed"] as const) ||
				!isSafeCount(payload.relatedSlot)
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { phase: payload.phase, relatedSlot: payload.relatedSlot },
			};
		case "skill-invocation":
			if (
				!hasExactKeys(payload, ["phase", "source"]) ||
				!isMember(payload.phase, ["started", "completed", "failed"] as const) ||
				!isMember(payload.source, ["managed", "user", "builtin", "unknown"] as const)
			)
				return undefined;
			return { kind: row.kind, slot, observedAt: at, payload: { phase: payload.phase, source: payload.source } };
		case "latency-sample":
			if (
				!hasExactKeys(payload, ["durationMs", "phase"]) ||
				!isSafeTime(payload.durationMs) ||
				!isMember(payload.phase, ["first-byte", "completion", "queue", "unknown"] as const)
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { durationMs: payload.durationMs, phase: payload.phase },
			};
		case "cache-outcome":
			if (
				!hasExactKeys(payload, ["outcome", "savedTokens"]) ||
				!isMember(payload.outcome, ["hit", "miss", "bypass"] as const) ||
				!isSafeCount(payload.savedTokens)
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { outcome: payload.outcome, savedTokens: payload.savedTokens },
			};
		case "signal-collision":
			if (
				!hasExactKeys(payload, ["count", "resolution"]) ||
				!isSafeCount(payload.count) ||
				!isMember(payload.resolution, ["coalesced", "dropped", "deferred"] as const)
			)
				return undefined;
			return {
				kind: row.kind,
				slot,
				observedAt: at,
				payload: { count: payload.count, resolution: payload.resolution },
			};
		case "numeric-history":
			if (
				!hasExactKeys(payload, ["value", "series"]) ||
				!isFiniteNumber(payload.value) ||
				!isMember(payload.series, ["rate", "count", "ratio", "duration"] as const)
			)
				return undefined;
			return { kind: row.kind, slot, observedAt: at, payload: { value: payload.value, series: payload.series } };
	}
}

function parseStep(value: unknown, previousAt: number): EvidenceTapeStepV1 | EvidenceReplayIssue {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-step";
	const row = value as Readonly<Record<string, unknown>>;
	if (!isSafeTime(row.at)) return "invalid-step";
	if (row.at < previousAt) return "non-monotonic-time";
	if (row.type === "observe") {
		const input = parseObservation(row, row.at);
		if (input === undefined) return "invalid-evidence";
		return {
			type: "observe",
			at: input.observedAt,
			kind: input.kind,
			slot: input.slot,
			payload: input.payload,
		} as EvidenceTapeObservationStepV1;
	}
	if (!hasExactKeys(row, SIMPLE_STEP_KEYS)) return "invalid-step";
	if (row.type !== "frame" && row.type !== "switch-root" && row.type !== "switch-session" && row.type !== "dispose")
		return "invalid-step";
	return { type: row.type, at: row.at };
}

function payloadToken(entry: TemporalEvidenceEntry): string {
	switch (entry.kind) {
		case "memory-observation":
			return `${entry.payload.status},${entry.payload.tier}`;
		case "causal-relation":
			return `${entry.payload.relation},${entry.payload.strength}`;
		case "freshness-transition":
			return `${entry.payload.from},${entry.payload.to}`;
		case "progress-observation":
			return `${entry.payload.completed},${entry.payload.total}`;
		case "retry-schedule":
			return `${entry.payload.attempt},${entry.payload.delayMs}`;
		case "cancellation-relation":
			return `${entry.payload.phase},${entry.payload.relatedSlot}`;
		case "skill-invocation":
			return `${entry.payload.phase},${entry.payload.source}`;
		case "latency-sample":
			return `${entry.payload.durationMs},${entry.payload.phase}`;
		case "cache-outcome":
			return `${entry.payload.outcome},${entry.payload.savedTokens}`;
		case "signal-collision":
			return `${entry.payload.count},${entry.payload.resolution}`;
		case "numeric-history":
			return `${entry.payload.value},${entry.payload.series}`;
	}
}

function hashText(hash: number, text: string): number {
	let next = hash;
	for (let index = 0; index < text.length; index++) {
		next ^= text.charCodeAt(index);
		next = Math.imul(next, 16_777_619);
	}
	return next >>> 0;
}

export function temporalEvidenceFrameHash(snapshot: TemporalEvidenceSnapshot): string {
	let hash = hashText(
		2_166_136_261,
		`v${EVIDENCE_FRAME_HASH_VERSION}|${snapshot.scopeVersion}|${snapshot.disposed ? 1 : 0}`,
	);
	for (const entry of snapshot.entries) {
		hash = hashText(
			hash,
			`|${entry.kind}|${entry.slot}|${entry.observedAt}|${entry.stage}|${entry.freshUntil}|${entry.recentUntil}|${entry.expiresAt}|${payloadToken(entry)}`,
		);
	}
	return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

/** Replays a content-free tape using tape timestamps as the only clock. */
export function replayEvidenceTape(input: unknown, policy?: TemporalEvidencePolicy): EvidenceReplayResult {
	if (typeof input !== "object" || input === null || Array.isArray(input))
		return Object.freeze({ ok: false, issue: "invalid-tape" });
	const tape = input as Readonly<Record<string, unknown>>;
	if (!hasExactKeys(tape, TAPE_KEYS)) return Object.freeze({ ok: false, issue: "invalid-tape" });
	if (tape.version !== EVIDENCE_TAPE_VERSION) return Object.freeze({ ok: false, issue: "unsupported-version" });
	if (!Array.isArray(tape.steps)) return Object.freeze({ ok: false, issue: "invalid-tape" });
	if (tape.steps.length > MAX_EVIDENCE_TAPE_STEPS) return Object.freeze({ ok: false, issue: "too-many-steps" });

	const steps: EvidenceTapeStepV1[] = [];
	let previousAt = 0;
	for (let index = 0; index < tape.steps.length; index++) {
		const parsed = parseStep(tape.steps[index], previousAt);
		if (typeof parsed === "string") return Object.freeze({ ok: false, issue: parsed, step: index });
		steps.push(parsed);
		previousAt = parsed.at;
	}

	const store = new TemporalEvidenceStore({ scope: { root: 0, session: 0 }, policy });
	const transitions: EvidenceReplayTransition[] = [];
	let root = 0;
	let session = 0;
	let frameVersion = 0;
	let previousSnapshot: TemporalEvidenceSnapshot | undefined;
	for (let index = 0; index < steps.length; index++) {
		const step = steps[index];
		switch (step.type) {
			case "observe":
				store.observe({
					kind: step.kind,
					slot: step.slot,
					observedAt: step.at,
					payload: step.payload,
				} as TemporalEvidenceInput);
				break;
			case "switch-root":
				root++;
				session = 0;
				store.switchScope({ root, session });
				break;
			case "switch-session":
				session++;
				store.switchScope({ root, session });
				break;
			case "dispose":
				store.dispose();
				break;
			case "frame":
				break;
		}
		const snapshot = store.snapshot(step.at);
		if (snapshot !== previousSnapshot) frameVersion++;
		previousSnapshot = snapshot;
		transitions.push(
			Object.freeze({
				step: index,
				at: step.at,
				action: step.type,
				tapeVersion: EVIDENCE_TAPE_VERSION,
				frameHashVersion: EVIDENCE_FRAME_HASH_VERSION,
				frameVersion,
				frameHash: temporalEvidenceFrameHash(snapshot),
				snapshotRevision: snapshot.revision,
				scopeVersion: snapshot.scopeVersion,
				disposed: snapshot.disposed,
				total: snapshot.counters.total,
				fresh: snapshot.counters.fresh,
				recent: snapshot.counters.recent,
				residual: snapshot.counters.residual,
			}),
		);
	}
	return Object.freeze({ ok: true, transitions: Object.freeze(transitions) });
}
