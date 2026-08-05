/**
 * Audit Trail Box — the pure working-set model.
 *
 * Tracks every path the agent touches and classifies it, so the harness can
 * answer "which of my in-context file copies are still true?" without asking
 * the user to label anything. The model is deliberately free of I/O: reads,
 * writes and disk probes all arrive as plain method calls carrying
 * already-computed hashes, which keeps the whole classifier deterministic and
 * unit-testable, and leaves hashing/scheduling to the controller.
 *
 * Five signal families feed the classifier, matching the bead's design:
 * - `ledger`    — read/write accounting: repeated reads of one path, or a path
 *                 rewritten enough times to show write amplification.
 * - `divergence`— the active disk probe found content that no longer matches
 *                 what the agent last accepted, or the path went unreachable.
 * - `cache`     — prefix economics: a path invalidated often, or a working set
 *                 grown past its soft cap.
 * - `recovery`  — behaviour that implies the agent/user already noticed a miss:
 *                 re-reading a path it just read, or compacting/clearing soon
 *                 after a poison flag.
 * - `lifecycle` — session shape: cold eviction candidates and unresolved risk
 *                 dropped at teardown.
 *
 * Two independent precision gates keep the box from crying wolf:
 * - Severity escalates to `alarm` only when >= 2 distinct families fire for the
 *   same path, combined with noisy-OR (independent evidence) rather than a
 *   weighted sum, so five weak signals never add up to a strong one.
 * - POISONED needs 2 consecutive probe ticks of divergence, and a flagged path
 *   then sits in a per-path cooldown where further probe ticks cannot re-flag it.
 */

/** One of the five independent evidence sources. Family COUNT is what gates severity — never a score sum. */
export type SignalFamily = "ledger" | "divergence" | "cache" | "recovery" | "lifecycle";

/** Stable iteration order for rendering and tests. */
export const SIGNAL_FAMILIES: readonly SignalFamily[] = ["ledger", "divergence", "cache", "recovery", "lifecycle"];

/**
 * Per-family probability that this family alone indicates a genuinely stale
 * copy. Combined with noisy-OR, so adding a family can raise confidence but can
 * never push it to 1 — an important property when the families are correlated
 * in practice (a poisoned path is usually also a re-read path).
 */
export const FAMILY_CONFIDENCE: Readonly<Record<SignalFamily, number>> = {
	ledger: 0.35,
	divergence: 0.7,
	cache: 0.3,
	recovery: 0.45,
	lifecycle: 0.2,
};

/**
 * How the agent's in-context copy of a path relates to what is on disk.
 * - `poisoned`  — disk changed under the agent (confirmed over 2 probe ticks) or the path went unreachable.
 * - `dirty`     — the agent wrote it, so its copy is its own text; formatters and hooks may have rewritten it since.
 * - `redundant` — read more than once with nothing invalidating it in between: pure prefix waste.
 * - `cold`      — untouched for {@link COLD_AFTER_TURNS} turns; an eviction candidate.
 * - `fresh`     — read this session and still matching the last probe.
 */
export type PathStatus = "poisoned" | "dirty" | "redundant" | "cold" | "fresh";

/** Highest risk first — the panel's sort order and the remedy lists' grouping. */
export const STATUS_RISK_ORDER: readonly PathStatus[] = ["poisoned", "dirty", "redundant", "cold", "fresh"];

/** `none` (no families), `watch` (exactly one), `alarm` (>= 2 — the >=2-family gate). */
export type Severity = "none" | "watch" | "alarm";

/** Consecutive probe ticks of divergence before POISONED sticks. */
export const POISON_STREAK_TICKS = 2;

/**
 * How long after an agent write an external rewrite is read as the repo's own
 * formatter rather than a hostile edit. `bun run fix` / `biome format --write`
 * lands within a second or two of the write that triggered it; a genuine
 * external edit landing inside that window is rare enough that treating it as
 * formatter churn is the right trade against alarming on every formatted edit.
 */
export const FORMATTER_WINDOW_MS = 4_000;

/** After a POISONED flag, further probe ticks cannot re-flag the same path for this long. */
export const PATH_COOLDOWN_MS = 30_000;

/** Turns without a touch before a path becomes a cold-eviction candidate. */
export const COLD_AFTER_TURNS = 8;

/** A `/compact` or `/clear` within this window of a poison flag is read as recovery from that flag. */
export const RECOVERY_WINDOW_MS = 60_000;

/** Distinct tracked paths past which the working set counts as bloated. */
export const WORKING_SET_SOFT_CAP = 40;

/** Redundant reads of one path before the `ledger` family fires for it. */
export const REDUNDANT_READ_THRESHOLD = 2;

/** Writes to one path before the `ledger` family fires for it (write amplification). */
export const WRITE_AMPLIFICATION_THRESHOLD = 3;

/** Prefix invalidations on one path before the `cache` family fires for it. */
export const CACHE_INVALIDATION_THRESHOLD = 3;

/**
 * Cap on the content snapshots kept per path. The remedy's before-discard diff
 * only needs enough to show the user what moved, and the tracker holds one
 * snapshot per tracked path — an uncapped copy of every touched file would make
 * the box itself the memory problem it is trying to report.
 */
export const MAX_TRACKED_CONTENT_CHARS = 4_096;

/** Combine independent family evidence: `1 - Π(1 - p)`. Empty set is 0; the result is always < 1. */
export function noisyOr(families: Iterable<SignalFamily>): number {
	let miss = 1;
	for (const family of families) miss *= 1 - FAMILY_CONFIDENCE[family];
	return 1 - miss;
}

/** The >=2-family gate: one family is a watch item, two or more independent families is an alarm. */
export function severityFor(families: ReadonlySet<SignalFamily>): Severity {
	if (families.size === 0) return "none";
	return families.size >= 2 ? "alarm" : "watch";
}

/** Truncate a content snapshot to {@link MAX_TRACKED_CONTENT_CHARS}. */
function capContent(content: string | undefined): string | undefined {
	if (content === undefined) return undefined;
	return content.length <= MAX_TRACKED_CONTENT_CHARS ? content : content.slice(0, MAX_TRACKED_CONTENT_CHARS);
}

/** What the agent observed about a path when it read or wrote it. */
export interface TouchObservation {
	/** Content hash as the agent saw it. Omitted when the tool gave no usable body. */
	readonly hash?: string;
	/** Content as the agent saw it, kept (capped) for the remedy's before-discard diff. */
	readonly content?: string;
}

/** One path's result from a single probe tick. */
export interface ProbeReading {
	readonly path: string;
	/** Hash observed on disk now; `undefined` when the path is unreachable. */
	readonly hash: string | undefined;
	/** Content observed on disk now, for the before-discard diff. */
	readonly content?: string;
	/** False when the path was deleted or the probe hit EPERM. */
	readonly reachable: boolean;
}

/** Immutable per-path view handed to renderers and the remedy builder. */
export interface PathRecord {
	readonly path: string;
	readonly status: PathStatus;
	readonly severity: Severity;
	/** Noisy-OR over {@link families}. Ranks paths within a status; never gates on its own. */
	readonly confidence: number;
	readonly families: ReadonlySet<SignalFamily>;
	readonly reads: number;
	readonly writes: number;
	readonly redundantReads: number;
	readonly prefixInvalidations: number;
	/** Consecutive probe ticks that saw divergence. Resets on any read or accepted baseline. */
	readonly divergenceStreak: number;
	readonly reachable: boolean;
	readonly lastTouchTurn: number;
	/** Hash of the copy the agent believes it holds. Only a read or a write moves this. */
	readonly contextHash: string | undefined;
	/** The copy the agent believes it holds (capped), diffed against {@link contentNow} before it is discarded. */
	readonly contextContent: string | undefined;
	/** Hash the probe last observed on disk. */
	readonly hashNow: string | undefined;
	/** Content the probe last observed on disk (capped). */
	readonly contentNow: string | undefined;
	/** Probe ticks whose divergence was absorbed as the repo's own formatter. */
	readonly formatterAbsorbs: number;
	/** Probe ticks cannot re-flag this path until this timestamp. */
	readonly cooldownUntilMs: number;
}

/** Session-wide ledger and cache economics. */
export interface LedgerMetrics {
	readonly reads: number;
	readonly writes: number;
	readonly distinctPaths: number;
	readonly distinctWrittenPaths: number;
	readonly redundantReads: number;
	/** `redundantReads / reads`, or 0 before any read. */
	readonly redundantReadRatio: number;
	/** `writes / distinctWrittenPaths`, or 0 before any write. 1 means every write hit a different file. */
	readonly writeAmplification: number;
	readonly prefixInvalidations: number;
	/** `distinctPaths / WORKING_SET_SOFT_CAP`; above 1 the working set is over cap. */
	readonly workingSetBloat: number;
	/** Poison flags followed by a `/compact` or `/clear` inside {@link RECOVERY_WINDOW_MS}. */
	readonly recoveryCorrelations: number;
	/** Session teardowns that discarded still-unresolved POISONED/DIRTY paths. */
	readonly teardownLeaks: number;
}

/** Immutable snapshot handed to the pure renderers each frame. */
export interface AuditSnapshot {
	readonly turn: number;
	/** All tracked paths, highest risk first (see {@link STATUS_RISK_ORDER}), then confidence desc, then path asc. */
	readonly paths: readonly PathRecord[];
	readonly counts: Readonly<Record<PathStatus, number>>;
	readonly metrics: LedgerMetrics;
}

interface MutableRecord {
	path: string;
	status: PathStatus;
	families: Set<SignalFamily>;
	reads: number;
	writes: number;
	redundantReads: number;
	prefixInvalidations: number;
	divergenceStreak: number;
	reachable: boolean;
	lastTouchTurn: number;
	contextHash: string | undefined;
	contextContent: string | undefined;
	baselineHash: string | undefined;
	hashNow: string | undefined;
	contentNow: string | undefined;
	formatterAbsorbs: number;
	formatterWindowUntilMs: number;
	cooldownUntilMs: number;
	poisonedAtMs: number | undefined;
}

const STATUS_RANK: Readonly<Record<PathStatus, number>> = {
	poisoned: 0,
	dirty: 1,
	redundant: 2,
	cold: 3,
	fresh: 4,
};

function freeze(record: MutableRecord): PathRecord {
	const families: ReadonlySet<SignalFamily> = new Set(record.families);
	return {
		path: record.path,
		status: record.status,
		severity: severityFor(families),
		confidence: noisyOr(families),
		families,
		reads: record.reads,
		writes: record.writes,
		redundantReads: record.redundantReads,
		prefixInvalidations: record.prefixInvalidations,
		divergenceStreak: record.divergenceStreak,
		reachable: record.reachable,
		lastTouchTurn: record.lastTouchTurn,
		contextHash: record.contextHash,
		contextContent: record.contextContent,
		hashNow: record.hashNow,
		contentNow: record.contentNow,
		formatterAbsorbs: record.formatterAbsorbs,
		cooldownUntilMs: record.cooldownUntilMs,
	};
}

/**
 * Mutable, session-scoped tracker of the agent's own working set.
 *
 * Every method is a plain state transition — no timers, no filesystem, no
 * randomness — so the whole classifier can be driven turn by turn in tests. The
 * controller adapts `tool_call`/`tool_result` events into {@link noteRead} /
 * {@link noteWrite}, drives {@link noteProbe} off the frame clock, and clears
 * the tracker on session teardown via {@link noteSessionSwitch}.
 */
export class AuditLedgerState {
	#paths = new Map<string, MutableRecord>();
	#turn = 0;
	#reads = 0;
	#writes = 0;
	#writtenPaths = new Set<string>();
	#redundantReads = 0;
	#prefixInvalidations = 0;
	#recoveryCorrelations = 0;
	#teardownLeaks = 0;

	/** Current turn index. Advanced by {@link noteTurn}. */
	get turn(): number {
		return this.#turn;
	}

	/** Number of tracked paths. */
	get size(): number {
		return this.#paths.size;
	}

	/** One path's frozen record, or `undefined` when untracked. */
	record(path: string): PathRecord | undefined {
		const found = this.#paths.get(path);
		return found === undefined ? undefined : freeze(found);
	}

	/**
	 * The agent read `path`. A read always re-establishes the baseline: whatever
	 * the probe saw before, the agent now holds the on-disk truth, so the
	 * divergence streak resets and a POISONED path drops back to FRESH — this is
	 * the remedy landing. A second read of a path that is already FRESH or
	 * REDUNDANT with nothing invalidating it in between is the implicit miss
	 * signal the bead calls for: it fires `recovery`, and enough of them fire
	 * `ledger` too. Takes no timestamp — nothing a read does is time-dependent.
	 */
	noteRead(path: string, observed: TouchObservation = {}): void {
		const record = this.#ensure(path);
		const wasCached = record.status === "fresh" || record.status === "redundant";
		record.reads++;
		this.#reads++;
		record.lastTouchTurn = this.#turn;

		const isRepeat = wasCached && record.reads > 1;
		if (isRepeat) {
			record.redundantReads++;
			this.#redundantReads++;
			record.families.add("recovery");
			if (record.redundantReads >= REDUNDANT_READ_THRESHOLD) record.families.add("ledger");
		}

		if (observed.hash !== undefined) {
			record.contextHash = observed.hash;
			record.baselineHash = observed.hash;
			record.hashNow = observed.hash;
		}
		if (observed.content !== undefined) {
			record.contextContent = capContent(observed.content);
			record.contentNow = capContent(observed.content);
		}
		record.divergenceStreak = 0;
		record.families.delete("divergence");
		record.reachable = true;
		record.cooldownUntilMs = 0;
		record.poisonedAtMs = undefined;
		record.formatterWindowUntilMs = 0;
		record.status = isRepeat ? "redundant" : "fresh";
	}

	/**
	 * The agent wrote `path` (write or edit). The path goes DIRTY and opens a
	 * {@link FORMATTER_WINDOW_MS} window in which an external rewrite is read as
	 * this repo's own formatter rather than a hostile edit. Writing a path the
	 * agent had already read invalidates that prefix entry, which is what the
	 * `cache` family counts.
	 */
	noteWrite(path: string, nowMs: number, observed: TouchObservation = {}): void {
		const record = this.#ensure(path);
		if (record.reads > 0 || record.writes > 0) {
			record.prefixInvalidations++;
			this.#prefixInvalidations++;
			if (record.prefixInvalidations >= CACHE_INVALIDATION_THRESHOLD) record.families.add("cache");
		}
		record.writes++;
		this.#writes++;
		this.#writtenPaths.add(path);
		record.lastTouchTurn = this.#turn;
		if (record.writes >= WRITE_AMPLIFICATION_THRESHOLD) record.families.add("ledger");

		if (observed.hash !== undefined) {
			record.contextHash = observed.hash;
			record.baselineHash = observed.hash;
			record.hashNow = observed.hash;
		}
		if (observed.content !== undefined) {
			record.contextContent = capContent(observed.content);
			record.contentNow = capContent(observed.content);
		}
		record.divergenceStreak = 0;
		record.families.delete("divergence");
		record.reachable = true;
		record.formatterWindowUntilMs = nowMs + FORMATTER_WINDOW_MS;
		record.cooldownUntilMs = 0;
		record.poisonedAtMs = undefined;
		record.status = "dirty";
	}

	/**
	 * Apply one probe tick. Divergence needs {@link POISON_STREAK_TICKS}
	 * consecutive ticks before POISONED sticks, a flagged path then sits in a
	 * per-path cooldown, and divergence landing inside a DIRTY path's formatter
	 * window is absorbed: the on-disk baseline advances so the next tick is not a
	 * fresh divergence, but the agent's in-context copy is left alone so the
	 * remedy can still diff it. Untracked paths in `readings` are ignored.
	 */
	noteProbe(readings: readonly ProbeReading[], nowMs: number): void {
		for (const reading of readings) {
			const record = this.#paths.get(reading.path);
			if (record === undefined) continue;

			record.hashNow = reading.hash;
			// An unreachable path has no content on disk — say so, rather than leaving the
			// last known bytes standing in for a file that is gone. A reachable probe that
			// captured no content (hash-only tick) keeps whatever was last observed.
			if (!reading.reachable) record.contentNow = undefined;
			else if (reading.content !== undefined) record.contentNow = capContent(reading.content);
			if (nowMs < record.cooldownUntilMs) continue;

			if (!reading.reachable) {
				record.reachable = false;
				this.#escalate(record, nowMs);
				continue;
			}
			record.reachable = true;

			const baseline = record.baselineHash;
			if (baseline === undefined || reading.hash === undefined || reading.hash === baseline) {
				record.divergenceStreak = 0;
				continue;
			}

			if (record.status === "dirty" && nowMs <= record.formatterWindowUntilMs) {
				// This repo's own `bun run fix` rewriting a file the agent just wrote is
				// byte-identical in shape to a hostile edit. Accept the formatted bytes as
				// the new on-disk baseline (so the next tick is not a fresh divergence)
				// while leaving `contextContent` on the pre-format text the agent holds —
				// the path is already DIRTY, which the remedy already lists as must-re-read.
				record.formatterAbsorbs++;
				record.baselineHash = reading.hash;
				record.divergenceStreak = 0;
				continue;
			}

			this.#escalate(record, nowMs);
		}
	}

	/**
	 * Advance one turn, then sweep for cold-eviction candidates. POISONED and
	 * DIRTY paths are never swept to COLD — an unresolved stale copy does not
	 * become safe to drop by being ignored. A working set over
	 * {@link WORKING_SET_SOFT_CAP} additionally fires `cache` on each cold path,
	 * since those are exactly the entries bloating the prefix.
	 */
	noteTurn(): void {
		this.#turn++;
		const overCap = this.#paths.size > WORKING_SET_SOFT_CAP;
		for (const record of this.#paths.values()) {
			if (record.status === "poisoned" || record.status === "dirty") continue;
			if (this.#turn - record.lastTouchTurn < COLD_AFTER_TURNS) continue;
			record.status = "cold";
			record.families.add("lifecycle");
			if (overCap) record.families.add("cache");
		}
	}

	/**
	 * A `/compact` or `/clear` landed. Any path poisoned inside
	 * {@link RECOVERY_WINDOW_MS} correlates the alarm with the user's recovery,
	 * which fires `recovery` on it — the second family that lifts a lone
	 * divergence flag to `alarm`. Derived entirely from observed behaviour; the
	 * user is never asked to label anything.
	 */
	noteRecovery(nowMs: number): void {
		for (const record of this.#paths.values()) {
			if (record.poisonedAtMs === undefined) continue;
			if (nowMs - record.poisonedAtMs > RECOVERY_WINDOW_MS) continue;
			if (!record.families.has("recovery")) this.#recoveryCorrelations++;
			record.families.add("recovery");
		}
	}

	/**
	 * Session switch or shutdown: drop the whole working set. Discarding paths
	 * that were still POISONED or DIRTY means unresolved risk left the session
	 * without a remedy — the teardown leak the bead asks for. Returns the number
	 * of paths dropped.
	 */
	noteSessionSwitch(): number {
		let unresolved = 0;
		for (const record of this.#paths.values()) {
			if (record.status === "poisoned" || record.status === "dirty") unresolved++;
		}
		if (unresolved > 0) this.#teardownLeaks++;
		const dropped = this.#paths.size;
		this.#paths.clear();
		this.#writtenPaths.clear();
		return dropped;
	}

	/** Immutable view for the pure renderers and the remedy builder. */
	snapshot(): AuditSnapshot {
		const paths = [...this.#paths.values()].map(freeze).sort(comparePathRecords);
		const counts: Record<PathStatus, number> = { poisoned: 0, dirty: 0, redundant: 0, cold: 0, fresh: 0 };
		for (const record of paths) counts[record.status]++;
		return {
			turn: this.#turn,
			paths,
			counts,
			metrics: {
				reads: this.#reads,
				writes: this.#writes,
				distinctPaths: this.#paths.size,
				distinctWrittenPaths: this.#writtenPaths.size,
				redundantReads: this.#redundantReads,
				redundantReadRatio: this.#reads === 0 ? 0 : this.#redundantReads / this.#reads,
				writeAmplification: this.#writtenPaths.size === 0 ? 0 : this.#writes / this.#writtenPaths.size,
				prefixInvalidations: this.#prefixInvalidations,
				workingSetBloat: this.#paths.size / WORKING_SET_SOFT_CAP,
				recoveryCorrelations: this.#recoveryCorrelations,
				teardownLeaks: this.#teardownLeaks,
			},
		};
	}

	/** Count one confirmed-divergence tick, flagging POISONED once the streak clears hysteresis. */
	#escalate(record: MutableRecord, nowMs: number): void {
		record.divergenceStreak++;
		if (record.divergenceStreak < POISON_STREAK_TICKS) return;
		record.status = "poisoned";
		record.families.add("divergence");
		record.poisonedAtMs = nowMs;
		record.cooldownUntilMs = nowMs + PATH_COOLDOWN_MS;
	}

	#ensure(path: string): MutableRecord {
		const existing = this.#paths.get(path);
		if (existing !== undefined) return existing;
		const created: MutableRecord = {
			path,
			status: "fresh",
			families: new Set(),
			reads: 0,
			writes: 0,
			redundantReads: 0,
			prefixInvalidations: 0,
			divergenceStreak: 0,
			reachable: true,
			lastTouchTurn: this.#turn,
			contextHash: undefined,
			contextContent: undefined,
			baselineHash: undefined,
			hashNow: undefined,
			contentNow: undefined,
			formatterAbsorbs: 0,
			formatterWindowUntilMs: 0,
			cooldownUntilMs: 0,
			poisonedAtMs: undefined,
		};
		this.#paths.set(path, created);
		return created;
	}
}

/** Panel/remedy ordering: risk band first, then confidence desc, then path asc for a stable render. */
export function comparePathRecords(a: PathRecord, b: PathRecord): number {
	const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
	if (byStatus !== 0) return byStatus;
	const byConfidence = b.confidence - a.confidence;
	if (byConfidence !== 0) return byConfidence;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
