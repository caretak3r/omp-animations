import type { TemporalEvidenceStage } from "../animations-box/temporal-evidence";
import { ageText } from "../duration";

export const MEMORY_BACKENDS = ["off", "local", "hindsight", "mnemopi"] as const;
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];

export const MEMORY_SCOPES = [
	"global",
	"per-project",
	"per-project-tagged",
	"project",
	"session",
	"user",
	"workspace",
] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_ERROR_IDENTIFIERS = [
	"AbortError",
	"DatabaseError",
	"TimeoutError",
	"EACCES",
	"ECONNREFUSED",
	"E_DB_BUSY",
	"E_DB_LOCKED",
	"ENOENT",
	"ETIMEDOUT",
	"SQLITE_BUSY",
	"SQLITE_LOCKED",
] as const;
export type MemoryErrorIdentifier = (typeof MEMORY_ERROR_IDENTIFIERS)[number];
export type MemoryObservationError = MemoryErrorIdentifier | "STATUS_UNAVAILABLE" | "unknown";

export const MEMORY_OBSERVATION_STALE_MS = 30_000;
export const MEMORY_TIDE_MAX_ROWS = 3;
export const MEMORY_TIDE_MAX_WIDTH = 160;
export const MAX_MEMORY_COUNT = 999_999_999_999;
const MAX_FAILURE_COUNT = 999;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export type MemoryRecallReport = "reported" | "not-reported" | undefined;

export interface MemoryTideStatus {
	readonly backend: MemoryBackend;
	readonly active: boolean | undefined;
	readonly writable: boolean | undefined;
	readonly searchable: boolean | undefined;
	readonly scope: MemoryScope | undefined;
	readonly workingCount: number | undefined;
	readonly episodicCount: number | undefined;
	readonly tripleCount: number | undefined;
	/** Age at observation time. A timestamp is never retained. */
	readonly lastMemoryAgeMs: number | undefined;
	readonly lastRecall: MemoryRecallReport;
	/** Age at observation time when the host supplies recall timestamp metadata. */
	readonly lastRecallAgeMs: number | undefined;
	readonly error: MemoryErrorIdentifier | undefined;
}

export interface MemoryStatusAdapterClock {
	/** Monotonic timestamp used by the reducer and renderer. */
	readonly observedAt: number;
	/** Wall-clock timestamp used only to turn host timestamps into non-sensitive ages. */
	readonly wallTimeMs?: number;
}

export type MemoryCountChange =
	| { readonly kind: "none" }
	| { readonly kind: "observed delta"; readonly amount: number }
	| { readonly kind: "reset/rebase" };

export interface MemoryCountState {
	readonly value: number | undefined;
	readonly change: MemoryCountChange;
}

export interface MemoryTideGoodObservation {
	readonly observedAt: number;
	readonly status: MemoryTideStatus;
	readonly working: MemoryCountState;
	readonly episodic: MemoryCountState;
	readonly triples: MemoryCountState;
	readonly transition: "none" | "reset/rebase";
	/** Monotonic time at which recall was first reported for the current lineage. */
	readonly recallReportedAt: number | undefined;
}

export interface MemoryTidePollFailure {
	readonly failedAt: number;
	readonly error: MemoryObservationError;
	readonly consecutiveFailures: number;
}

export interface MemoryTideState {
	readonly sequence: number;
	readonly lastGood: MemoryTideGoodObservation | undefined;
	readonly pollFailure: MemoryTidePollFailure | undefined;
}

interface MemoryTidePollBase {
	readonly sequence: number;
	readonly observedAt: number;
}

export interface MemoryTidePollSuccess extends MemoryTidePollBase {
	readonly kind: "success";
	readonly status: unknown;
	/**
	 * Set when the caller knows a private backend root changed. The root itself
	 * must never cross this boundary; only this non-identifying comparison does.
	 */
	readonly rootChanged?: boolean;
	readonly wallTimeMs?: number;
}

export interface MemoryTidePollFailureInput extends MemoryTidePollBase {
	readonly kind: "failure";
	readonly error?: unknown;
}

export type MemoryTidePoll = MemoryTidePollSuccess | MemoryTidePollFailureInput;

export type MemoryTideRenderMode = "detailed" | "compact" | "reduced";
export type MemoryTideSymbols = "unicode" | "ascii";
export type MemoryTideTokenTone = "label" | "normal" | "positive" | "negative" | "warning" | "muted" | "accent";
export type MemoryTideTokenSemantic =
	| "label"
	| "backend"
	| "motion"
	| "capability"
	| "scope"
	| "status"
	| "observation"
	| "count"
	| "change"
	| "recency";

export interface MemoryTideRowToken {
	readonly semantic: MemoryTideTokenSemantic;
	readonly text: string;
	readonly tone: MemoryTideTokenTone;
	readonly truncated?: true;
}

export interface MemoryTideRow {
	readonly tokens: readonly MemoryTideRowToken[];
}

export interface MemoryTideRenderOptions {
	readonly now: number;
	readonly width: number;
	readonly height: number;
	readonly mode: MemoryTideRenderMode;
	readonly symbols?: MemoryTideSymbols;
	/** Caller-supplied evidence phase. Reduced mode deliberately ignores it. */
	readonly stage?: TemporalEvidenceStage;
}

const BACKEND_SET = new Set<string>(MEMORY_BACKENDS);
const SCOPE_SET = new Set<string>(MEMORY_SCOPES);
const ERROR_SET = new Set<string>(MEMORY_ERROR_IDENTIFIERS);

function allowlistedString<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
	return typeof value === "string" && allowed.has(value) ? (value as T) : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function count(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
	return Math.min(value, MAX_MEMORY_COUNT);
}

function monotonicTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number") return monotonicTime(value);
	if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeAge(value: unknown, wallTimeMs: number | undefined): number | undefined {
	const at = timestampMs(value);
	if (at === undefined || wallTimeMs === undefined || !Number.isFinite(wallTimeMs) || wallTimeMs < at)
		return undefined;
	return Math.min(wallTimeMs - at, Number.MAX_SAFE_INTEGER);
}

function recallReport(value: unknown): MemoryRecallReport {
	if (value === true) return "reported";
	if (value === false) return "not-reported";
	return timestampMs(value) === undefined ? undefined : "reported";
}

/** Extract only an exact allowlisted class/code; arbitrary error text never survives. */
export function normalizeMemoryError(value: unknown): MemoryErrorIdentifier | undefined {
	if (typeof value === "string") {
		const candidate = value.split(/[\s:]/, 1)[0];
		return allowlistedString<MemoryErrorIdentifier>(candidate, ERROR_SET);
	}
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const record = value as Record<string, unknown>;
		return (
			allowlistedString<MemoryErrorIdentifier>(record.code, ERROR_SET) ??
			allowlistedString<MemoryErrorIdentifier>(record.name, ERROR_SET)
		);
	} catch {
		return undefined;
	}
}

/**
 * Strict host-status adapter. It copies only allowlisted scalar facts and
 * converts timestamps to ages. Database paths, bank identifiers, messages,
 * content, raw errors, and every unknown property are structurally excluded.
 */
export function normalizeMemoryBackendStatus(
	input: unknown,
	clock: MemoryStatusAdapterClock,
): MemoryTideStatus | undefined {
	const observedAt = monotonicTime(clock.observedAt);
	if (observedAt === undefined || typeof input !== "object" || input === null) return undefined;
	try {
		const status = input as Record<string, unknown>;
		const backend = allowlistedString<MemoryBackend>(status.backend, BACKEND_SET);
		if (backend === undefined) return undefined;
		const wallTimeMs = monotonicTime(clock.wallTimeMs);
		return {
			backend,
			active: optionalBoolean(status.active),
			writable: optionalBoolean(status.writable),
			searchable: optionalBoolean(status.searchable),
			scope: allowlistedString<MemoryScope>(status.scope, SCOPE_SET),
			workingCount: count(status.workingCount),
			episodicCount: count(status.episodicCount),
			tripleCount: count(status.tripleCount),
			lastMemoryAgeMs: safeAge(status.lastMemory, wallTimeMs),
			lastRecall: recallReport(status.lastRecall),
			lastRecallAgeMs: safeAge(status.lastRecall, wallTimeMs),
			error: normalizeMemoryError(status.error),
		};
	} catch {
		return undefined;
	}
}

export function createMemoryTideState(): MemoryTideState {
	return { sequence: -1, lastGood: undefined, pollFailure: undefined };
}

function sameLineage(previous: MemoryTideStatus, current: MemoryTideStatus, rootChanged: boolean | undefined): boolean {
	return rootChanged !== true && previous.backend === current.backend && previous.scope === current.scope;
}

function compareCount(
	previous: number | undefined,
	current: number | undefined,
	comparable: boolean,
): MemoryCountState {
	if (current === undefined) return { value: undefined, change: { kind: "none" } };
	if (!comparable) return { value: current, change: { kind: "reset/rebase" } };
	if (previous === undefined || previous === current) return { value: current, change: { kind: "none" } };
	if (current < previous) return { value: current, change: { kind: "reset/rebase" } };
	return { value: current, change: { kind: "observed delta", amount: current - previous } };
}

function nextRecallReportedAt(
	previous: MemoryTideGoodObservation | undefined,
	status: MemoryTideStatus,
	observedAt: number,
	comparable: boolean,
): number | undefined {
	if (status.lastRecall !== "reported") return undefined;
	if (status.lastRecallAgeMs !== undefined) return Math.max(0, observedAt - status.lastRecallAgeMs);
	if (comparable && previous?.status.lastRecall === "reported") return previous.recallReportedAt;
	return observedAt;
}

/** Pure, overlap-safe poll transition. Only a strictly newer sequence settles. */
export function reduceMemoryTide(state: MemoryTideState, poll: MemoryTidePoll): MemoryTideState {
	const sequence = count(poll.sequence);
	const observedAt = monotonicTime(poll.observedAt);
	if (sequence === undefined || observedAt === undefined || sequence <= state.sequence) return state;

	if (poll.kind === "failure") {
		return {
			sequence,
			lastGood: state.lastGood,
			pollFailure: {
				failedAt: observedAt,
				error: normalizeMemoryError(poll.error) ?? "unknown",
				consecutiveFailures: Math.min((state.pollFailure?.consecutiveFailures ?? 0) + 1, MAX_FAILURE_COUNT),
			},
		};
	}

	const status = normalizeMemoryBackendStatus(poll.status, { observedAt, wallTimeMs: poll.wallTimeMs });
	if (status === undefined) {
		return {
			sequence,
			lastGood: state.lastGood,
			pollFailure: {
				failedAt: observedAt,
				error: "STATUS_UNAVAILABLE",
				consecutiveFailures: Math.min((state.pollFailure?.consecutiveFailures ?? 0) + 1, MAX_FAILURE_COUNT),
			},
		};
	}

	const previous = state.lastGood;
	const lineageMatches = previous !== undefined && sameLineage(previous.status, status, poll.rootChanged);
	const comparable = lineageMatches && previous.status.active === true && status.active === true;
	const transition = previous !== undefined && !lineageMatches ? "reset/rebase" : "none";
	const working = compareCount(previous?.status.workingCount, status.workingCount, comparable);
	const episodic = compareCount(previous?.status.episodicCount, status.episodicCount, comparable);
	const triples = compareCount(previous?.status.tripleCount, status.tripleCount, comparable);

	// An initial observation establishes a baseline rather than claiming a reset.
	const baseline = previous === undefined;
	const lastGood: MemoryTideGoodObservation = {
		observedAt,
		status,
		working: baseline ? { value: status.workingCount, change: { kind: "none" } } : working,
		episodic: baseline ? { value: status.episodicCount, change: { kind: "none" } } : episodic,
		triples: baseline ? { value: status.tripleCount, change: { kind: "none" } } : triples,
		transition,
		recallReportedAt: nextRecallReportedAt(previous, status, observedAt, comparable),
	};
	return { sequence, lastGood, pollFailure: undefined };
}

export type MemoryObservationFreshness = "missing" | "fresh" | "stale";

export function memoryObservationFreshness(state: MemoryTideState, now: number): MemoryObservationFreshness {
	if (state.lastGood === undefined) return "missing";
	const safeNow = monotonicTime(now) ?? state.lastGood.observedAt;
	return safeNow - state.lastGood.observedAt > MEMORY_OBSERVATION_STALE_MS ? "stale" : "fresh";
}

function yesNoUnknown(value: boolean | undefined): string {
	if (value === undefined) return "?";
	return value ? "yes" : "no";
}

function token(semantic: MemoryTideTokenSemantic, text: string, tone: MemoryTideTokenTone): MemoryTideRowToken {
	return { semantic, text, tone };
}

function changeTokens(label: string, countState: MemoryCountState): readonly MemoryTideRowToken[] {
	if (countState.change.kind === "none") return [];
	if (countState.change.kind === "reset/rebase") {
		return [token("change", `${label} reset/rebase`, "warning")];
	}
	return [token("change", `${label} +${countState.change.amount} observed`, "accent")];
}

function motionToken(stage: TemporalEvidenceStage, symbols: MemoryTideSymbols): MemoryTideRowToken {
	const unicode = stage === "fresh" ? "▓" : stage === "recent" ? "▒" : "░";
	const ascii = stage === "fresh" ? "#" : stage === "recent" ? "+" : ".";
	return token("motion", symbols === "ascii" ? ascii : unicode, "accent");
}

function readinessToken(state: MemoryTideState, now: number): MemoryTideRowToken {
	const status = state.lastGood?.status;
	if (status === undefined) return token("status", "status unknown", "muted");
	if (status.backend === "off") return token("status", "backend off", "warning");
	if (state.pollFailure !== undefined) {
		return token("status", `check failed ${state.pollFailure.error}`, "warning");
	}
	if (status.error !== undefined) return token("status", `error ${status.error}`, "negative");
	if (status.active === false) return token("status", "unavailable", "warning");
	if (memoryObservationFreshness(state, now) === "stale") return token("status", "status stale", "muted");
	if (status.active === undefined) return token("status", "status unknown", "muted");
	if (status.writable === false) return token("status", "read only", "warning");
	if (status.searchable === false) return token("status", "search unavailable", "warning");
	return token("status", "ready", "positive");
}

function fitRows(tokens: readonly MemoryTideRowToken[], width: number, height: number): readonly MemoryTideRow[] {
	const rows: MemoryTideRow[] = [];
	let current: MemoryTideRowToken[] = [];
	let currentWidth = 0;
	for (const item of tokens) {
		if (rows.length >= height) break;
		const separator = current.length === 0 ? 0 : 1;
		if (currentWidth + separator + item.text.length <= width) {
			current.push(item);
			currentWidth += separator + item.text.length;
			continue;
		}
		if (current.length > 0) {
			rows.push({ tokens: current });
			if (rows.length >= height) break;
			current = [];
			currentWidth = 0;
		}
		if (item.text.length <= width) {
			current.push(item);
			currentWidth = item.text.length;
		} else {
			current.push({ ...item, text: item.text.slice(0, width), truncated: true });
			currentWidth = width;
		}
	}
	if (current.length > 0 && rows.length < height) rows.push({ tokens: current });
	return rows;
}

/** Plain-text projection for tests and color-free terminals. */
export function memoryTideRowText(row: MemoryTideRow): string {
	return row.tokens.map(item => item.text).join(" ");
}

/**
 * Pure semantic renderer. Tone is advisory only: every capability, error,
 * freshness, delta, and rebase remains explicit in text without color or motion.
 */
export function renderMemoryTide(state: MemoryTideState, options: MemoryTideRenderOptions): readonly MemoryTideRow[] {
	const width = Math.min(MEMORY_TIDE_MAX_WIDTH, Math.max(0, Math.floor(options.width)));
	const height = Math.min(MEMORY_TIDE_MAX_ROWS, Math.max(0, Math.floor(options.height)));
	const good = state.lastGood;
	if (width === 0 || height === 0 || good === undefined) return [];

	const now = monotonicTime(options.now) ?? good.observedAt;
	if (options.mode === "compact") {
		return fitRows([token("label", "MEM", "label"), readinessToken(state, now)], width, height);
	}
	if (good.status.backend === "off") return [];
	const elapsed = Math.max(0, now - good.observedAt);
	const reduced = options.mode === "reduced";
	const symbols = options.symbols ?? "unicode";
	const status = good.status;
	const hasChange =
		good.transition === "reset/rebase" ||
		good.working.change.kind !== "none" ||
		good.episodic.change.kind !== "none" ||
		good.triples.change.kind !== "none";
	const tokens: MemoryTideRowToken[] = [token("label", "MEM", "label"), token("backend", status.backend, "normal")];
	if (!reduced && hasChange && options.stage !== undefined) tokens.push(motionToken(options.stage, symbols));

	tokens.push(
		token("capability", `active:${yesNoUnknown(status.active)}`, status.active === false ? "negative" : "normal"),
		token(
			"capability",
			`writable:${yesNoUnknown(status.writable)}`,
			status.writable === false ? "negative" : "normal",
		),
		token(
			"capability",
			`searchable:${yesNoUnknown(status.searchable)}`,
			status.searchable === false ? "negative" : "normal",
		),
	);
	if (status.scope !== undefined) tokens.push(token("scope", `scope:${status.scope}`, "muted"));
	else tokens.push(token("scope", "scope:?", "muted"));

	if (status.active === false) tokens.push(token("status", "status:unavailable", "warning"));
	if (status.error !== undefined) tokens.push(token("status", `status:error:${status.error}`, "negative"));
	if (state.pollFailure !== undefined) {
		tokens.push(token("observation", `obs:error:${state.pollFailure.error}`, "warning"));
		tokens.push(token("observation", `last-good:${ageText(elapsed)}`, "warning"));
	} else if (elapsed > MEMORY_OBSERVATION_STALE_MS) {
		tokens.push(token("observation", `obs:stale:${ageText(elapsed)}`, "warning"));
	} else {
		tokens.push(token("observation", "obs:fresh", "positive"));
	}

	const countLabels = ["work", "episodic", "triples"] as const;
	for (const [label, entry] of [
		[countLabels[0], good.working],
		[countLabels[1], good.episodic],
		[countLabels[2], good.triples],
	] as const) {
		if (entry.value !== undefined) tokens.push(token("count", `${label}:${entry.value}`, "normal"));
		tokens.push(...changeTokens(label, entry));
	}
	if (
		good.transition === "reset/rebase" &&
		good.working.change.kind === "none" &&
		good.episodic.change.kind === "none" &&
		good.triples.change.kind === "none"
	) {
		tokens.push(token("change", "reset/rebase", "warning"));
	}

	if (status.lastMemoryAgeMs !== undefined) {
		tokens.push(token("recency", `memory:${ageText(status.lastMemoryAgeMs + elapsed)}-ago`, "muted"));
	}
	if (status.lastRecall === undefined) {
		tokens.push(token("recency", "recall:?", "muted"));
	} else if (status.lastRecall === "reported" && good.recallReportedAt !== undefined) {
		tokens.push(token("recency", `recall:reported:${ageText(now - good.recallReportedAt)}-ago`, "accent"));
	} else {
		tokens.push(token("recency", "recall:not-reported", "muted"));
	}

	return fitRows(tokens, width, height);
}
