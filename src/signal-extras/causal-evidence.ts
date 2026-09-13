export const DEFAULT_CAUSAL_EVIDENCE_CAPACITY = 32;
export const DEFAULT_CAUSAL_EVIDENCE_TTL_MS = 60_000;

export type CausalEvidenceRelationKind =
	| "tool-local-start"
	| "tool-local-result"
	| "retry-reschedule"
	| "retry-dispatch"
	| "retry-outcome"
	| "cancellation-request"
	| "cancellation-ack";

export type CausalEvidenceFamily = "tool" | "retry" | "cancellation";
export type CausalEvidenceKeyPart = string | number | symbol;

export interface CausalEvidenceEndpoint {
	/** Private session namespace. It is retained only in the non-serializable ledger. */
	readonly session?: CausalEvidenceKeyPart;
	/** Private caller-issued relation. It is never projected into render output. */
	readonly relation?: CausalEvidenceKeyPart;
	readonly kind: CausalEvidenceRelationKind;
}

export interface CausalEvidenceLedgerOptions {
	readonly capacity?: number;
	readonly ttlMs?: number;
}

interface StageCount {
	readonly kind: CausalEvidenceRelationKind;
	readonly count: number;
}

interface IncidentRecord {
	readonly session: CausalEvidenceKeyPart;
	readonly relation: CausalEvidenceKeyPart;
	readonly family: CausalEvidenceFamily;
	readonly stages: readonly StageCount[];
	readonly createdAt: number;
	readonly updatedAt: number;
}

const INCIDENTS = Symbol("causal-evidence-incidents");

/**
 * Immutable bounded join state. Incident keys live behind a symbol so ordinary
 * JSON/log serialization cannot disclose them.
 */
export interface CausalEvidenceLedger {
	readonly capacity: number;
	readonly ttlMs: number;
	readonly [INCIDENTS]: readonly IncidentRecord[];
}

export interface CausalEvidenceRenderOptions {
	readonly now: number;
	readonly width: number;
	readonly unicode: boolean;
	readonly color: boolean;
	readonly reducedMotion: boolean;
	readonly phase: number;
}

export type CausalEvidenceTokenRole = "label" | "node" | "edge" | "activity" | "repeat";
export type CausalEvidenceTone = "neutral" | "active" | "terminal";

export interface CausalEvidenceTopologyToken {
	readonly role: CausalEvidenceTokenRole;
	readonly text: string;
	readonly cells: number;
	readonly semantic?: CausalEvidenceRelationKind;
	readonly tone?: CausalEvidenceTone;
	readonly animated: boolean;
}

export interface CausalEvidenceTopology {
	readonly family: CausalEvidenceFamily;
	readonly terminal: boolean;
	readonly stopping: boolean;
	readonly tokens: readonly CausalEvidenceTopologyToken[];
	readonly text: string;
}

export interface CausalEvidenceFrame {
	/** Frame lint may inspect this projection; it contains no caller metadata. */
	readonly safeForFrameLint: true;
	readonly topologies: readonly CausalEvidenceTopology[];
}

interface FamilyDefinition {
	readonly family: CausalEvidenceFamily;
	readonly sequence: readonly CausalEvidenceRelationKind[];
}

const TOOL_SEQUENCE = ["tool-local-start", "tool-local-result"] as const;
const RETRY_SEQUENCE = ["retry-reschedule", "retry-dispatch", "retry-outcome"] as const;
const CANCELLATION_SEQUENCE = ["cancellation-request", "cancellation-ack"] as const;

function definitionFor(kind: CausalEvidenceRelationKind): FamilyDefinition {
	if (kind === "tool-local-start" || kind === "tool-local-result") {
		return { family: "tool", sequence: TOOL_SEQUENCE };
	}
	if (kind === "retry-reschedule" || kind === "retry-dispatch" || kind === "retry-outcome") {
		return { family: "retry", sequence: RETRY_SEQUENCE };
	}
	return { family: "cancellation", sequence: CANCELLATION_SEQUENCE };
}

function isExplicitKeyPart(value: CausalEvidenceKeyPart | undefined): value is CausalEvidenceKeyPart {
	if (value === undefined) return false;
	if (typeof value === "string") return value.length > 0;
	if (typeof value === "number") return Number.isFinite(value);
	return true;
}

function isTerminal(record: IncidentRecord): boolean {
	const sequence = definitionFor(record.stages[0]?.kind ?? "tool-local-start").sequence;
	return record.stages.length === sequence.length;
}

function freezeStages(stages: readonly StageCount[]): readonly StageCount[] {
	return Object.freeze(stages.map(stage => Object.freeze(stage)));
}

function freezeRecord(record: IncidentRecord): IncidentRecord {
	return Object.freeze({ ...record, stages: freezeStages(record.stages) });
}

function makeLedger(capacity: number, ttlMs: number, incidents: readonly IncidentRecord[]): CausalEvidenceLedger {
	return Object.freeze({
		capacity,
		ttlMs,
		[INCIDENTS]: Object.freeze(incidents.map(freezeRecord)),
	});
}

export function createCausalEvidenceLedger(options: CausalEvidenceLedgerOptions = {}): CausalEvidenceLedger {
	const capacity = Math.max(0, Math.floor(options.capacity ?? DEFAULT_CAUSAL_EVIDENCE_CAPACITY));
	const ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_CAUSAL_EVIDENCE_TTL_MS));
	return makeLedger(capacity, ttlMs, []);
}

/** Removes incidents solely from the caller's monotonic time. */
export function expireCausalEvidence(ledger: CausalEvidenceLedger, now: number): CausalEvidenceLedger {
	const incidents = ledger[INCIDENTS].filter(record => now - record.updatedAt < ledger.ttlMs);
	if (incidents.length === ledger[INCIDENTS].length) return ledger;
	return makeLedger(ledger.capacity, ledger.ttlMs, incidents);
}

function oldestIndex(records: readonly IncidentRecord[], terminalOnly: boolean): number {
	let selected = -1;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record === undefined || (terminalOnly && !isTerminal(record))) continue;
		const previous = selected < 0 ? undefined : records[selected];
		if (
			previous === undefined ||
			record.updatedAt < previous.updatedAt ||
			(record.updatedAt === previous.updatedAt && record.createdAt < previous.createdAt)
		) {
			selected = index;
		}
	}
	return selected;
}

function makeRoom(records: readonly IncidentRecord[]): IncidentRecord[] {
	const next = [...records];
	const terminal = oldestIndex(next, true);
	const evicted = terminal >= 0 ? terminal : oldestIndex(next, false);
	if (evicted >= 0) next.splice(evicted, 1);
	return next;
}

/**
 * Admits one endpoint only by exact session + relation equality. Orphans,
 * skipped stages, family changes, and completed-key reuse are ignored.
 */
export function joinCausalEvidence(
	ledger: CausalEvidenceLedger,
	endpoint: CausalEvidenceEndpoint,
	now: number,
): CausalEvidenceLedger {
	const current = expireCausalEvidence(ledger, now);
	if (current.capacity === 0 || !isExplicitKeyPart(endpoint.session) || !isExplicitKeyPart(endpoint.relation)) {
		return current;
	}

	const definition = definitionFor(endpoint.kind);
	const records = current[INCIDENTS];
	const recordIndex = records.findIndex(
		record => Object.is(record.session, endpoint.session) && Object.is(record.relation, endpoint.relation),
	);

	if (recordIndex < 0) {
		if (endpoint.kind !== definition.sequence[0]) return current;
		const next = records.length >= current.capacity ? makeRoom(records) : [...records];
		next.push({
			session: endpoint.session,
			relation: endpoint.relation,
			family: definition.family,
			stages: [{ kind: endpoint.kind, count: 1 }],
			createdAt: now,
			updatedAt: now,
		});
		return makeLedger(current.capacity, current.ttlMs, next);
	}

	const record = records[recordIndex];
	if (record === undefined || record.family !== definition.family) return current;
	const last = record.stages.at(-1);
	if (last === undefined) return current;

	let stages: readonly StageCount[];
	if (endpoint.kind === last.kind) {
		stages = [...record.stages.slice(0, -1), { kind: last.kind, count: last.count + 1 }];
	} else {
		if (isTerminal(record) || endpoint.kind !== definition.sequence[record.stages.length]) return current;
		stages = [...record.stages, { kind: endpoint.kind, count: 1 }];
	}

	const next = [...records];
	next[recordIndex] = { ...record, stages, updatedAt: now };
	return makeLedger(current.capacity, current.ttlMs, next);
}

function stageLabel(kind: CausalEvidenceRelationKind, narrow: boolean, terminal: boolean): string {
	if (narrow) {
		switch (kind) {
			case "tool-local-start":
				return "S";
			case "tool-local-result":
				return "R";
			case "retry-reschedule":
				return "R";
			case "retry-dispatch":
				return "D";
			case "retry-outcome":
				return "O";
			case "cancellation-request":
				return terminal ? "C" : "STOP";
			case "cancellation-ack":
				return "A";
		}
	}

	switch (kind) {
		case "tool-local-start":
			return "start";
		case "tool-local-result":
			return "result";
		case "retry-reschedule":
			return "rescheduled";
		case "retry-dispatch":
			return "dispatched";
		case "retry-outcome":
			return "outcome";
		case "cancellation-request":
			return terminal ? "requested" : "stopping";
		case "cancellation-ack":
			return "acknowledged";
	}
}

function activityGlyph(unicode: boolean, reducedMotion: boolean, phase: number): string {
	if (reducedMotion) return unicode ? "●" : "o";
	const unicodeFrames = ["·", "•", "●", "•"] as const;
	const asciiFrames = [".", "o", "O", "o"] as const;
	const frames = unicode ? unicodeFrames : asciiFrames;
	const index = ((Math.floor(phase) % frames.length) + frames.length) % frames.length;
	return frames[index] ?? frames[0];
}

function token(
	role: CausalEvidenceTokenRole,
	text: string,
	animated: boolean,
	semantic?: CausalEvidenceRelationKind,
	tone?: CausalEvidenceTone,
): CausalEvidenceTopologyToken {
	return Object.freeze({
		role,
		text,
		cells: text.length,
		...(semantic === undefined ? {} : { semantic }),
		...(tone === undefined ? {} : { tone }),
		animated,
	});
}

function topologyFor(record: IncidentRecord, options: CausalEvidenceRenderOptions): CausalEvidenceTopology {
	const terminal = isTerminal(record);
	const stopping = record.family === "cancellation" && !terminal;
	const narrow = options.width < 36;
	const tone = options.color ? (terminal ? "terminal" : "active") : undefined;
	const tokens: CausalEvidenceTopologyToken[] = [token("label", record.family, false, undefined, tone)];

	for (const [index, stage] of record.stages.entries()) {
		if (index > 0) tokens.push(token("edge", options.unicode ? "→" : ">", false, undefined, tone));
		tokens.push(token("node", stageLabel(stage.kind, narrow, terminal), false, stage.kind, tone));
		if (stage.count > 1) tokens.push(token("repeat", `×${stage.count}`, false, stage.kind, tone));
	}
	if (!terminal) {
		tokens.push(
			token(
				"activity",
				activityGlyph(options.unicode, options.reducedMotion, options.phase),
				!options.reducedMotion,
				undefined,
				tone,
			),
		);
	}

	const topology = tokens.slice(1);
	const body = narrow
		? topology.map(item => item.text).join("")
		: topology
				.map(item => item.text)
				.join(" ")
				.replace(/ ×/g, "×");
	return Object.freeze({
		family: record.family,
		terminal,
		stopping,
		tokens: Object.freeze(tokens),
		text: `${record.family} ${body}`,
	});
}

/** Projects safe, deterministic topology tokens. No key, text payload, or age is exposed. */
export function renderCausalEvidence(
	ledger: CausalEvidenceLedger,
	options: CausalEvidenceRenderOptions,
): CausalEvidenceFrame {
	const current = expireCausalEvidence(ledger, options.now);
	return Object.freeze({
		safeForFrameLint: true,
		topologies: Object.freeze(current[INCIDENTS].map(record => topologyFor(record, options))),
	});
}
