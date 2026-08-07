/**
 * Animations Box — segment sources.
 *
 * One pure builder per box-owned animation, each producing a {@link
 * SegmentSample}: the simple-mode `variants` ladder (fed straight into the
 * kit's `composeSegments`) plus the detailed-mode column fields, both derived
 * from that animation's own exported pure renderers/state — never reinvented
 * text. Cache Meter (`oh-my-pi-dxi.2`), Audit Trail, Tool Constellation,
 * Palimpsest, Cadence Equalizer, Rate-Limit Tidepool and Reflection Ripple
 * (`oh-my-pi-dxi.3`/`oh-my-pi-dxi.4`) are wired here; the breathing border
 * lands in `oh-my-pi-dxi.5`.
 *
 * `active` mirrors the animation's own real mount policy (quiet until the
 * first usable event, mirroring `CacheMeterController`'s lazy mount), but
 * unlike the standalone widget's absence, an inactive segment here still
 * produces a `detail` — a dim resting row (`glyph · label · "—"`) — so
 * detailed-mode height is a pure function of the ENABLED set, never of
 * runtime activity (Plan 017 Decision 5).
 *
 * `now` is always a wall-clock reading from the box's own `FrameScheduler`,
 * never the host `AnimatedWidget`'s mount-relative `elapsedMs` (Decision 4).
 */
import { basename } from "node:path";
import type { SymbolPreset, Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { formatNumber } from "@oh-my-pi/pi-utils";
import {
	BADGE_GLYPH as AUDIT_BADGE_GLYPH,
	AUDIT_TRAIL_BOX_COLORS,
	type AuditLedgerState,
	type AuditTrailBoxColors,
	type PathRecord,
	renderAuditMeterRow,
	STATUS_GLYPHS,
	STATUS_RISK_ORDER,
} from "../audit-trail-box";
import {
	BADGE_GLYPH,
	CACHE_METER_COLORS,
	type CacheMeterColors,
	type CacheMeterState,
	renderCacheMeterRow,
} from "../cache-meter";
import {
	type CadenceEqualizerColors,
	type CadenceEqualizerState,
	cadenceEqualizerColors,
	renderCompactEqualizer,
	renderEqualizerRow,
	renderEqualizerText,
} from "../cadence-equalizer";
// `MAX_REFERENCE_RATE` lives in `scale.ts`, which the keeper's own `index.ts`
// barrel does not re-export (only `bars`/`controller`/`state`/`widget` do) —
// a deep import, not a reinvented constant, since editing that barrel is a
// keeper-directory change out of this bead's scope (see `dxi.4`'s report).
import { MAX_REFERENCE_RATE } from "../cadence-equalizer/scale";
import { resolveGlyph } from "../glyph-presets";
import {
	GLOW_THRESHOLD,
	PALIMPSEST_COLORS,
	type PalimpsestColors,
	type PalimpsestRow,
	type PalimpsestState,
} from "../palimpsest";
import {
	type RateLimitTidepoolState,
	refillLevel,
	renderTidepoolRow,
	TIDEPOOL_COLORS,
	type TidepoolColors,
} from "../rate-limit-tidepool";
import {
	REFLECTION_RIPPLE_COLORS,
	type ReflectionRippleColors,
	type ReflectionRippleState,
	renderReflectionRippleRow,
} from "../reflection-ripple";
import {
	CATEGORY_ICON,
	CATEGORY_ORDER,
	CATEGORY_THEME_COLOR,
	type ConstellationState,
	EMPTY_GLYPH,
	renderConstellationTally,
	type ToolCategory,
} from "../tool-constellation";
import { BOX_SEGMENT_IDS, type BoxSegmentId } from "./settings";

/** The slice of {@link Theme} every segment builder needs — just foreground coloring. */
export type BoxTheme = Pick<Theme, "fg">;

/** One column's worth of detailed-mode text — always plain, colored last by the segment builder itself (the widget does no coloring of its own). */
export interface SegmentDetail {
	readonly glyph: string;
	readonly label: string;
	readonly primary: string;
	readonly secondary: string;
	readonly trailing: string;
}

/** What one segment contributes this frame, in both box detail levels. */
export interface SegmentSample {
	readonly id: BoxSegmentId;
	readonly priority: number;
	/** Whether this segment currently has real content to show. Gates `composeSegments` participation (simple mode) only — `variants` is empty when `false`, so an idle segment contributes nothing to that one composed row. */
	readonly active: boolean;
	/** Widest-first, for `composeSegments`. Empty when `!active`. */
	readonly variants: readonly string[];
	/** Column fields for detailed mode — always populated, even when `!active` (a resting row, not an absence; see the module doc). */
	readonly detail: SegmentDetail;
}

const INACTIVE = { active: false as const, variants: [] as const };

/** Priority order derives from `BOX_SEGMENT_IDS` so it can never drift from the settings module's own list. */
function priorityOf(id: BoxSegmentId): number {
	return BOX_SEGMENT_IDS.indexOf(id) + 1;
}

function dedupe(variants: readonly string[]): readonly string[] {
	const out: string[] = [];
	for (const v of variants) if (out.at(-1) !== v) out.push(v);
	return out;
}

/** `<$0.01`/`$1.24`-style USD formatting — a local copy of `cache-meter/widget.ts`'s module-private `formatCost` (not exported from that module's barrel). */
function formatCost(amountUsd: number): string {
	const safe = Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : 0;
	if (safe === 0) return "$0.00";
	return safe < 0.01 ? "<$0.01" : `$${safe.toFixed(2)}`;
}

/**
 * Cache Meter segment. A dim resting row until `message_end` has delivered at
 * least one usable prompt-cache sample — mirrors `CacheMeterController`'s own
 * lazy mount ("nothing to show before the first metered request lands").
 * Unlike the standalone `CacheMeterWidget`, this segment never eases the
 * displayed percentage or blinks the invalidation badge — both live inside
 * that widget's own per-frame state, which this box does not reuse (see
 * `controller.ts`'s module doc) — so it always draws the snapshot's true
 * current `warmth`, unalerted.
 */
export function buildCacheMeterSegment(
	state: CacheMeterState,
	now: number,
	theme: BoxTheme,
	colors: CacheMeterColors = CACHE_METER_COLORS,
): SegmentSample {
	const priority = priorityOf("cacheMeter");
	const snapshot = state.snapshot();
	if (snapshot.promptTokens === 0) {
		return {
			id: "cacheMeter",
			priority,
			...INACTIVE,
			detail: { glyph: theme.fg("dim", BADGE_GLYPH), label: "cache", primary: "—", secondary: "", trailing: "" },
		};
	}

	const variants = dedupe(
		[999, 40, 18, 3].map(width =>
			renderCacheMeterRow(snapshot, width, now, theme, "subtle", snapshot.warmth, false, colors),
		),
	);
	const pct = `${(snapshot.warmth * 100).toFixed(1)}%`;
	return {
		id: "cacheMeter",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(colors.badge, BADGE_GLYPH),
			label: "cache",
			primary: pct,
			secondary:
				snapshot.savedCost !== undefined
					? `saved ${formatCost(snapshot.savedCost)}`
					: `${snapshot.hitCount}/${snapshot.requestCount}`,
			trailing: `r ${formatNumber(snapshot.cacheReadTokens)} · w ${formatNumber(snapshot.cacheWriteTokens)}`,
		},
	};
}

/** Same idle convention as the keeper's own `renderEqualizerText` ("--" when nothing is streaming), without that renderer's `eq ` row prefix — this is a column value, not a standalone row. */
function cadenceRateLabel(tokensPerSecond: number | null): string {
	if (tokensPerSecond === null || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "--";
	return `${Math.round(tokensPerSecond)} t/s`;
}

/**
 * Cadence Equalizer segment. Unlike every other builder in this file, its
 * `state` alone can't answer "has anything ever happened" — the EMA bands
 * decay back toward (but never quite reach) zero between turns, so the box
 * controller tracks `hasStreamed` itself (latched `true` on the first
 * assistant `message_start`, mirroring `CadenceEqualizerController`'s own
 * mount trigger) and the live sampled rate (from the same
 * `calculateTokensPerSecond` provider that controller's `sampleRate` calls),
 * neither of which lives on `CadenceEqualizerState`. The detail glyph is
 * always the live `renderCompactEqualizer` strip rather than a separate fixed
 * resting badge (this keeper exports no badge glyph) — at true rest the bands
 * are exactly zero, so the same call already renders the correct dim resting
 * strip, reusing the exported renderer instead of inventing new text.
 */
export function buildCadenceEqualizerSegment(
	state: CadenceEqualizerState,
	hasStreamed: boolean,
	tokensPerSecond: number | null,
	_now: number,
	theme: BoxTheme,
	colors: CadenceEqualizerColors = cadenceEqualizerColors(),
): SegmentSample {
	const priority = priorityOf("cadenceEqualizer");
	const bands = state.snapshotBands();
	const glyph = renderCompactEqualizer(bands, theme, colors);
	if (!hasStreamed) {
		return {
			id: "cadenceEqualizer",
			priority,
			...INACTIVE,
			detail: { glyph, label: "cadence", primary: "—", secondary: "", trailing: "" },
		};
	}

	const peaks = state.snapshotPeaks();
	const variants = dedupe([
		renderEqualizerRow(bands, peaks, theme, colors),
		renderCompactEqualizer(bands, theme, colors),
		renderEqualizerText(tokensPerSecond),
	]);

	// The peak-hold ceiling across every band, denormalized back to a tok/s-ish
	// reading — same amplitude-to-rate projection `MAX_REFERENCE_RATE` anchors
	// throughout `scale.ts` (see `normalizeAmplitude`'s inverse).
	let peakAmplitude = 0;
	for (const peak of peaks) if (peak > peakAmplitude) peakAmplitude = peak;

	return {
		id: "cadenceEqualizer",
		priority,
		active: true,
		variants,
		detail: {
			glyph,
			label: "cadence",
			primary: cadenceRateLabel(tokensPerSecond),
			secondary: `peak ${Math.round(peakAmplitude * MAX_REFERENCE_RATE)}`,
			trailing: renderEqualizerRow(bands, peaks, theme, colors),
		},
	};
}

/**
 * Audit Trail segment. A dim resting row until the first tracked touch lands
 * (`state.size > 0`) — mirrors `AuditTrailBoxController`'s own real mount
 * policy, which pushes its first widget content from the very first
 * `noteRead`/`noteWrite`. Like Cache Meter, this segment never reproduces
 * the standalone widget's per-frame cosmetics: the alarm badge's pulse blink
 * lives inside `AuditTrailBoxWidget` itself (see `controller.ts`'s module
 * doc), so the glyph here always draws the plain poisoned/badge color,
 * unpulsed.
 */
export function buildAuditTrailBoxSegment(
	state: AuditLedgerState,
	now: number,
	theme: BoxTheme,
	colors: AuditTrailBoxColors = AUDIT_TRAIL_BOX_COLORS,
): SegmentSample {
	const priority = priorityOf("auditTrailBox");
	if (state.size === 0) {
		return {
			id: "auditTrailBox",
			priority,
			...INACTIVE,
			detail: {
				glyph: theme.fg("dim", AUDIT_BADGE_GLYPH),
				label: "audit",
				primary: "—",
				secondary: "",
				trailing: "",
			},
		};
	}

	const snapshot = state.snapshot();
	const variants = dedupe(
		[999, 40, 18].map(width => renderAuditMeterRow(snapshot, width, now, theme, "subtle", colors)),
	);

	const counts = STATUS_RISK_ORDER.filter(status => snapshot.counts[status] > 0)
		.map(status => `${snapshot.counts[status]}${STATUS_GLYPHS[status]}`)
		.join(" ");
	// Most recently touched path, for the "last path" column — snapshot.paths is
	// already risk-sorted, not recency-sorted, so this needs its own scan.
	let lastTouched: PathRecord | undefined;
	for (const record of snapshot.paths) {
		if (lastTouched === undefined || record.lastTouchTurn > lastTouched.lastTouchTurn) lastTouched = record;
	}
	const metrics = snapshot.metrics;

	return {
		id: "auditTrailBox",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(snapshot.counts.poisoned > 0 ? colors.poisoned : colors.badge, AUDIT_BADGE_GLYPH),
			label: "audit",
			primary: counts,
			secondary: lastTouched === undefined ? "" : basename(lastTouched.path),
			trailing: `r/w ${metrics.reads}/${metrics.writes} · ×${metrics.writeAmplification.toFixed(1)}`,
		},
	};
}

/** `resets <N>m`/`resets <N>s`-style ETA to the binding bucket's reset, or `""` when the response reported none. */
function resetEtaLabel(resetAtMs: number | undefined, now: number): string {
	if (resetAtMs === undefined) return "";
	const remainingMs = resetAtMs - now;
	if (remainingMs <= 0) return "resets now";
	const minutes = Math.floor(remainingMs / 60_000);
	if (minutes >= 1) return `resets ${minutes}m`;
	return `resets ${Math.max(1, Math.round(remainingMs / 1000))}s`;
}

/**
 * Rate-Limit Tidepool segment. A dim resting row until the first recognized,
 * provider-whitelisted response lands (`state.snapshot() !== undefined`) —
 * mirrors `RateLimitTidepoolController`'s own lazy mount. The `{anthropic,
 * openai}` family whitelist is enforced upstream, in `controller.ts`'s
 * `onMessageStart` (mirroring `RateLimitTidepoolController.onMessageStart`
 * exactly) — this builder only ever sees a snapshot that already passed that
 * gate, so it never re-checks it. Like Cache Meter and Audit Trail, this
 * segment never reproduces the standalone widget's per-frame cosmetic (the
 * filled-edge-cell shimmer lives inside `TidepoolWidget` itself, gated on the
 * `full` motion tier this box never requests), so every variant renders at
 * the fixed `subtle` motion tier. The near-empty `sand` alarm color is fixed
 * regardless of `colors` — `TidepoolColors`/`tidepoolColors` only ever
 * override the `water` slot, so an accent override recolors the water alone,
 * exactly as the standalone widget's own accent contract promises.
 *
 * Rate-Limit Tidepool exports no badge glyph of its own — only bar-fill glyphs
 * (`WATER_GLYPH`/`WATER_SHIMMER_GLYPH`/`PEBBLE_GLYPH`/`SAND_GLYPH`) parametrized by tier
 * and animation phase. `box.limits` (`../glyph-presets.ts`) is this box's own literal
 * badge, matching Plan 017 Decision 1's table row (same precedent as `box.files`/
 * `box.reflect` below) — now preset-aware instead of a bare hardcoded `"◗"`.
 */
export function buildRateLimitTidepoolSegment(
	state: RateLimitTidepoolState,
	now: number,
	theme: BoxTheme,
	colors: TidepoolColors = TIDEPOOL_COLORS,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("rateLimitTidepool");
	const glyph = resolveGlyph("box.limits", preset);
	const snapshot = state.snapshot();
	if (snapshot === undefined) {
		return {
			id: "rateLimitTidepool",
			priority,
			...INACTIVE,
			detail: {
				glyph: theme.fg("dim", glyph),
				label: "limits",
				primary: "—",
				secondary: "",
				trailing: "",
			},
		};
	}

	const level = refillLevel(snapshot.level, now, snapshot.observedAtMs, snapshot.resetAtMs);
	const variants = dedupe(
		[999, 30, 12].map(width => renderTidepoolRow(level, snapshot.provider, now, width, theme, "subtle", colors)),
	);
	const clampedLevel = level <= 0 ? 0 : level >= 1 ? 1 : level;

	return {
		id: "rateLimitTidepool",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(colors.water, glyph),
			label: "limits",
			primary: `${Math.round(clampedLevel * 100)}%`,
			secondary: snapshot.provider,
			trailing: resetEtaLabel(snapshot.resetAtMs, now),
		},
	};
}

/** Highest-fire-count category, ties broken by {@link CATEGORY_ORDER}'s own canonical order. `undefined` when nothing has fired. */
function dominantCategory(counts: ReadonlyMap<ToolCategory, number>): ToolCategory | undefined {
	let best: ToolCategory | undefined;
	let bestCount = 0;
	for (const category of CATEGORY_ORDER) {
		const count = counts.get(category) ?? 0;
		if (count > bestCount) {
			best = category;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Tool Constellation segment. A dim resting row until the first `tool_call`
 * fires a star (`state.snapshot().stars.length > 0`) — mirrors
 * `ToolConstellationController`'s own mount policy. Its grid renderer is 3
 * rows tall and does not fit a one-row segment (Decision 1's first stated
 * exception), so both the widest and truncated simple-mode variants reuse
 * the exported `renderConstellationTally` instead — the widest variant over
 * every category that has fired, the truncated one over the dominant
 * category alone. Keeps the 7-way `CATEGORY_THEME_COLOR` rainbow: unlike
 * every other segment, there is no single accent slot to override here, so
 * this builder takes no `colors` parameter.
 */
export function buildToolConstellationSegment(state: ConstellationState, _now: number, theme: BoxTheme): SegmentSample {
	const priority = priorityOf("toolConstellation");
	const snapshot = state.snapshot();
	if (snapshot.stars.length === 0) {
		return {
			id: "toolConstellation",
			priority,
			...INACTIVE,
			detail: { glyph: theme.fg("dim", EMPTY_GLYPH), label: "tools", primary: "—", secondary: "", trailing: "" },
		};
	}

	const counts = state.categoryCounts();
	const dominant = dominantCategory(counts);
	const full = renderConstellationTally(counts, theme);
	const narrow =
		dominant === undefined ? full : renderConstellationTally(new Map([[dominant, counts.get(dominant) ?? 0]]), theme);
	const variants = dedupe([full, narrow]);

	const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
	const tally = CATEGORY_ORDER.filter(category => (counts.get(category) ?? 0) > 0)
		.map(category => `${CATEGORY_ICON[category]}${counts.get(category)}`)
		.join(" ");

	return {
		id: "toolConstellation",
		priority,
		active: true,
		variants,
		detail: {
			glyph:
				dominant === undefined
					? theme.fg("dim", EMPTY_GLYPH)
					: theme.fg(CATEGORY_THEME_COLOR[dominant], CATEGORY_ICON[dominant]),
			label: "tools",
			primary: `${total} calls`,
			secondary: dominant ?? "",
			trailing: tally,
		},
	};
}

/**
 * Same recency/overlap/path ordering `renderPalimpsestRows` sorts its visible
 * rows by — reproduced here since that comparator lives inline in that
 * function, not exported (same precedent as `formatCost` above).
 */
function compareVisibleRows(a: PalimpsestRow, b: PalimpsestRow): number {
	return b.lastTouchedTurn - a.lastTouchedTurn || b.overlapCount - a.overlapCount || a.path.localeCompare(b.path);
}

/**
 * Palimpsest segment. `renderPalimpsestRows` is multi-row and width-blind
 * (Decision 1's second stated exception), so this segment derives its own
 * one-line summary straight from `snapshot().rows` instead of calling it:
 * the single hottest visible row (overlap count at or above
 * `GLOW_THRESHOLD`, same threshold `PalimpsestController` mounts on),
 * narrowing from the full path to the basename to the bare count. Resting
 * until at least one row clears that threshold, mirroring
 * `PalimpsestController`'s own visibility-driven mount policy. Never
 * reproduces the ember tier's per-frame hot-pulse bolding — an
 * `AnimatedWidget`-only cosmetic, the same accepted gap as Cache Meter's
 * hit-rate ease (see `controller.ts`'s module doc).
 *
 * Palimpsest exports no badge glyph of its own (unlike Cache Meter's badge or Audit
 * Trail's badge) — `box.files` (`../glyph-presets.ts`) is this box's own literal,
 * matching Plan 017 Decision 5's detailed-mode mock, now preset-aware instead of a bare
 * hardcoded `"▓"`.
 */
export function buildPalimpsestSegment(
	state: PalimpsestState,
	_now: number,
	theme: BoxTheme,
	colors: PalimpsestColors = PALIMPSEST_COLORS,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("palimpsest");
	const glyph = resolveGlyph("box.files", preset);
	const visible = state
		.snapshot()
		.rows.filter(row => row.overlapCount >= GLOW_THRESHOLD)
		.sort(compareVisibleRows);
	if (visible.length === 0) {
		return {
			id: "palimpsest",
			priority,
			...INACTIVE,
			detail: {
				glyph: theme.fg("dim", glyph),
				label: "files",
				primary: "—",
				secondary: "",
				trailing: "",
			},
		};
	}

	const hottest = visible[0] as PalimpsestRow;
	const variants = dedupe([
		`${hottest.path} ×${hottest.overlapCount}`,
		`${basename(hottest.path)} ×${hottest.overlapCount}`,
		`×${hottest.overlapCount}`,
	]);

	return {
		id: "palimpsest",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(colors.ember, glyph),
			label: "files",
			primary: basename(hottest.path),
			secondary: `×${hottest.overlapCount}`,
			trailing: `${visible.length} row${visible.length === 1 ? "" : "s"}`,
		},
	};
}

/**
 * Reflection Ripple segment. Unlike every other segment in this file, its
 * resting state — `phase === "idle"` — is the COMMON case (Decision 1): a
 * ripple is only ever in flight for the ~1.6s its wave takes to settle, so
 * `active` here means "a ripple is CURRENTLY in flight," not "has ever
 * fired" (contrast Cadence Equalizer's `hasStreamed`, which latches
 * permanently once true). `now` is the box's own `FrameScheduler` wall
 * clock — the SAME clock `controller.ts` stamps `applyTrigger`'s trigger
 * timestamp with — so `state.rippleElapsedMs(now)` renders the correct phase
 * even when the trigger landed before the box's first repaint (Decision 4).
 *
 * Reflection Ripple exports no badge glyph of its own (only the phase-parametrized
 * `ringGlyph(brightness)`) — `box.reflect` (`../glyph-presets.ts`) is this box's own
 * literal, matching Plan 017 Decision 1's table row (same precedent as `box.files`/
 * `box.limits` above), now preset-aware instead of a bare hardcoded `"○"`.
 */
export function buildReflectionRippleSegment(
	state: ReflectionRippleState,
	now: number,
	theme: BoxTheme,
	colors: ReflectionRippleColors = REFLECTION_RIPPLE_COLORS,
	preset: SymbolPreset = "unicode",
): SegmentSample {
	const priority = priorityOf("reflectionRipple");
	const glyph = resolveGlyph("box.reflect", preset);
	const snapshot = state.snapshot();
	if (snapshot.phase !== "rippling") {
		return {
			id: "reflectionRipple",
			priority,
			...INACTIVE,
			detail: {
				glyph: theme.fg("dim", glyph),
				label: "reflect",
				primary: "—",
				secondary: "",
				trailing: "",
			},
		};
	}

	const elapsed = state.rippleElapsedMs(now);
	const variants = dedupe(
		[999, 40, 12].map(width => renderReflectionRippleRow(elapsed, width, theme, "subtle", colors)),
	);

	return {
		id: "reflectionRipple",
		priority,
		active: true,
		variants,
		detail: {
			glyph: theme.fg(colors.ring, glyph),
			label: "reflect",
			primary: snapshot.ruleNames.join(", "),
			secondary: String(snapshot.triggerCount),
			trailing: "—",
		},
	};
}
