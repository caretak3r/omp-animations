import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { resolveGlyph, resolveStarGlyphRamp } from "../glyph-presets";

/** Logical star-field grid. Fixed and independent of terminal width — layout stability comes from the hash, not the viewport. */
export const GRID_COLS = 10;
export const GRID_ROWS = 3;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;

/** How long a fresh fire holds at full brightness before decay begins. */
const FLARE_HOLD_MS = 260;
/** Exponential decay time-constant once the hold window ends. */
const DECAY_TAU_MS = 1400;
/** Brightness floor a star settles to once fully decayed (never fully dark). */
const BRIGHTNESS_FLOOR = 0.12;
/** Window after a fire during which the star still counts as the comet head. */
export const COMET_WINDOW_MS = 500;
/** Idle twinkle: a short bright blip recurring on a per-cell period. */
const TWINKLE_PERIOD_MS = 1800;
const TWINKLE_BLIP_MS = 140;

/**
 * 32-bit FNV-1a. Hand-rolled (not `Bun.hash`) so the grid-cell assignment is
 * guaranteed byte-stable across Bun versions/platforms, which the behavioral
 * snapshot tests depend on.
 */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** Deterministic starting cell for a tool name within the fixed grid. Pure. */
export function hashCell(toolName: string, cells = GRID_CELLS): number {
	return fnv1a(toolName) % cells;
}

/**
 * Assign a stable, collision-free cell for `toolName`: start at its hash and
 * linearly probe forward (wrapping) until an unoccupied cell is found. Pure
 * given `occupied`; deterministic because occupancy only grows in first-fire
 * order, which the caller controls.
 */
export function assignCell(toolName: string, occupied: ReadonlySet<number>, cells = GRID_CELLS): number {
	const start = hashCell(toolName, cells);
	for (let i = 0; i < cells; i++) {
		const idx = (start + i) % cells;
		if (!occupied.has(idx)) return idx;
	}
	return start; // grid saturated: share the hashed cell rather than losing the star.
}

/**
 * Brightness in `[BRIGHTNESS_FLOOR, 1]` as a pure function of milliseconds
 * since the star last fired. `Infinity` (never fired) reads as the floor.
 * Monotonically non-increasing in `msSinceFire`.
 */
export function starBrightness(msSinceFire: number): number {
	if (msSinceFire <= FLARE_HOLD_MS) return 1;
	const decayElapsed = msSinceFire - FLARE_HOLD_MS;
	const decayed = BRIGHTNESS_FLOOR + (1 - BRIGHTNESS_FLOOR) * Math.exp(-decayElapsed / DECAY_TAU_MS);
	return decayed;
}

/**
 * Whether a star seeded at `cell` is mid-twinkle-blip at `elapsedMs`. A short
 * periodic pulse, phase-offset per cell so the field doesn't blink in unison.
 * Pure integer arithmetic — no floats — so it stays exactly reproducible.
 */
export function isTwinkling(cell: number, elapsedMs: number): boolean {
	const phase = (elapsedMs + cell * 137) % TWINKLE_PERIOD_MS;
	return phase < TWINKLE_BLIP_MS;
}

/** Fixed length of the star ramp — every preset's ramp has exactly this many entries (see `../glyph-presets.ts`). */
const STAR_RAMP_LENGTH = 4;

/** Map a brightness value (`0..1`) to its index on the star ramp. Monotonic in brightness. */
export function starGlyphIndex(brightness: number): number {
	const clamped = brightness <= 0 ? 0 : brightness >= 1 ? 1 : brightness;
	return Math.min(STAR_RAMP_LENGTH - 1, Math.floor(clamped * STAR_RAMP_LENGTH));
}

/** Map a brightness value (`0..1`) to a glyph on the dimmest-to-brightest star ramp, resolved for `preset` via `../glyph-presets.ts`. Monotonic in brightness. Defaults to `"unicode"` — the original hardcoded values. */
export function starGlyph(brightness: number, preset: SymbolPreset = "unicode"): string {
	const ramp = resolveStarGlyphRamp(preset);
	return ramp[starGlyphIndex(brightness)] ?? ramp[0];
}

/** Newest-fired star, within {@link COMET_WINDOW_MS}, always renders as this glyph, resolved for `preset`. */
export function cometGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("toolConstellation.comet", preset);
}

/** Unassigned grid cell, resolved for `preset`. */
export function emptyGlyph(preset: SymbolPreset = "unicode"): string {
	return resolveGlyph("toolConstellation.empty", preset);
}
