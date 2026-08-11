/**
 * Braille-pattern sparkline renderer — maps sample buffers to high-resolution
 * trend visualization using Unicode Braille (U+2800–U+28FF). Each braille
 * character encodes 2 samples across its left and right 4-dot columns, giving
 * 5 discrete height levels (0–4 dots) per sample. Pure and deterministic.
 */

/** Braille blank pattern — no dots set. */
const BRAILLE_BASE = 0x2800;

/**
 * Braille dot bit values for bottom-up sparkline rendering. Each column has 4
 * dots (1,2,3,7 for left; 4,5,6,8 for right), filled from the bottom:
 * - Left column bottom-up:  dots {7, 3, 2, 1} = bits {0x40, 0x04, 0x02, 0x01}
 * - Right column bottom-up: dots {8, 6, 5, 4} = bits {0x80, 0x20, 0x10, 0x08}
 */
const LEFT_DOTS = [0x40, 0x04, 0x02, 0x01] as const;
const RIGHT_DOTS = [0x80, 0x20, 0x10, 0x08] as const;

/**
 * Map a normalized `[0, 1]` value to 0–4 dots. Returns the number of dots to
 * fill from the bottom (0 = blank, 4 = full column).
 */
function quantizeToDots(normalized: number): number {
	const clamped = normalized <= 0 ? 0 : normalized >= 1 ? 1 : normalized;
	// Distribute [0, 1] evenly across 5 discrete levels (0–4 dots).
	return Math.round(clamped * 4);
}

/**
 * Build a braille pattern encoding two samples — left sample in the left
 * column (dots 1,2,3,7), right sample in the right column (dots 4,5,6,8).
 * Each sample is quantized to 0–4 dots filled from the bottom.
 */
function encodeBraillePair(leftNormalized: number, rightNormalized: number | undefined): number {
	let pattern = BRAILLE_BASE;

	// Left column: fill N dots from the bottom.
	const leftDots = quantizeToDots(leftNormalized);
	for (let i = 0; i < leftDots; i++) {
		pattern |= LEFT_DOTS[i] ?? 0;
	}

	// Right column: fill N dots from the bottom (skip if undefined = odd sample count).
	if (rightNormalized !== undefined) {
		const rightDots = quantizeToDots(rightNormalized);
		for (let i = 0; i < rightDots; i++) {
			pattern |= RIGHT_DOTS[i] ?? 0;
		}
	}

	return pattern;
}

/**
 * Render a braille sparkline from a sample buffer. Each braille character
 * encodes 2 samples (left + right columns); odd sample counts use the left
 * column of the final character.
 *
 * @param samples — Sample buffer to visualize. Must be non-empty.
 * @param width — Maximum output length in characters (each braille char = 1 column).
 * @param max — Normalization ceiling; defaults to the max value in `samples`.
 *              Guards against zero (treated as 1 to avoid division by zero).
 * @returns A string of braille characters, length ≤ `width`.
 */
export function renderSparkline(samples: readonly number[], width: number, max?: number): string {
	if (samples.length === 0) return "";

	// Determine normalization ceiling — default to max of buffer, guard zero.
	const ceiling = max !== undefined ? max : Math.max(...samples, 0);
	const normalizationMax = ceiling > 0 ? ceiling : 1;

	// Normalize samples to [0, 1].
	const normalized = samples.map(s => {
		const clamped = s <= 0 ? 0 : s >= normalizationMax ? 1 : s / normalizationMax;
		return clamped;
	});

	// Encode pairs into braille characters.
	const chars: string[] = [];
	for (let i = 0; i < normalized.length && chars.length < width; i += 2) {
		const left = normalized[i] ?? 0;
		const right = i + 1 < normalized.length ? normalized[i + 1] : undefined;
		chars.push(String.fromCodePoint(encodeBraillePair(left, right)));
	}

	return chars.join("");
}
