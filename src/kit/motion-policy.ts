import type { BackpressureSignal } from "./backpressure";

/**
 * Resolved motion tier the whole animated-plugin family shares.
 * - `off`: no motion; widgets render one static frame and stay unsubscribed
 *   until the tier changes.
 * - `subtle`: reduced cadence (~12fps).
 * - `full`: full cadence (~30fps).
 */
export type MotionTier = "off" | "subtle" | "full";

/** The user-facing `animations` setting. Same values as {@link MotionTier}. */
export type MotionSetting = MotionTier;

/**
 * Ambient inputs the policy gates on. `hasUI` / `isTTY` mirror the runtime's
 * own capability checks; `env` supplies `NO_COLOR` / `CI` / `TERM`; the optional
 * `backpressure` signal forces `off` while the renderer is under pressure.
 */
export interface MotionEnvironment {
	/** False in print/RPC modes that have no interactive UI. */
	hasUI: boolean;
	/** False when stdout is not a TTY. */
	isTTY: boolean;
	/** Environment to read `NO_COLOR` / `CI` / `TERM` from. Defaults to `Bun.env`. */
	env?: Record<string, string | undefined>;
	/** Render-backpressure signal; when under pressure the tier is forced `off`. */
	backpressure?: BackpressureSignal;
}

/** An env var counts as "set" when present and non-empty (e.g. `CI=` does not gate). */
function isEnvSet(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

/**
 * Pure tier resolution. Any hard gate forces `off` regardless of the setting;
 * otherwise the setting passes through.
 */
export function resolveMotionTier(env: MotionEnvironment, setting: MotionSetting): MotionTier {
	if (setting === "off") return "off";
	if (!env.hasUI) return "off";
	if (!env.isTTY) return "off";
	const vars = env.env ?? Bun.env;
	if (isEnvSet(vars.NO_COLOR)) return "off";
	if (isEnvSet(vars.CI)) return "off";
	if (vars.TERM === "dumb") return "off";
	if (env.backpressure?.underPressure === true) return "off";
	return setting;
}

/** Cadence, in milliseconds per frame, for each motion tier. `off` never ticks. */
export const TIER_CADENCE_MS: Readonly<Record<MotionTier, number>> = {
	off: 0,
	// ~12fps: enough to read motion, cheap enough to stay out of the way.
	subtle: 1000 / 12,
	// 30fps, matching the TUI loader's RENDER_INTERVAL_MS (packages/tui/src/components/loader.ts:11).
	full: 1000 / 30,
};

/** Notified with the newly-resolved tier whenever it changes. */
export type MotionTierListener = (tier: MotionTier) => void;

/**
 * Live, re-resolvable motion policy. Holds the current setting + environment,
 * exposes the resolved {@link MotionTier}, and notifies subscribers when a
 * setting/environment change flips the tier. The {@link AnimationHost} reads
 * `tier` to pick cadence and whether to start at all, and subscribes so a
 * runtime settings change re-resolves live.
 */
export class MotionPolicy {
	#setting: MotionSetting;
	#env: MotionEnvironment;
	#tier: MotionTier;
	#listeners = new Set<MotionTierListener>();

	constructor(env: MotionEnvironment, setting: MotionSetting = "full") {
		this.#env = env;
		this.#setting = setting;
		this.#tier = resolveMotionTier(env, setting);
	}

	/** Currently-resolved tier. */
	get tier(): MotionTier {
		return this.#tier;
	}

	/** Cadence in ms/frame for the current tier (`0` when `off`). */
	get cadenceMs(): number {
		return TIER_CADENCE_MS[this.#tier];
	}

	/** Number of subscribed tier listeners. Mirrors `AnimationHost.subscriberCount` for leak checks. */
	get listenerCount(): number {
		return this.#listeners.size;
	}

	/** Update the `animations` setting and re-resolve. */
	setSetting(setting: MotionSetting): void {
		if (setting === this.#setting) return;
		this.#setting = setting;
		this.#reresolve();
	}

	/** Replace the ambient environment (e.g. after a resize/mode change) and re-resolve. */
	setEnvironment(env: MotionEnvironment): void {
		this.#env = env;
		this.#reresolve();
	}

	/** Re-read the environment (including live backpressure) and re-resolve. */
	refresh(): void {
		this.#reresolve();
	}

	/** Subscribe to tier changes. Returns an unsubscribe function. */
	subscribe(listener: MotionTierListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#reresolve(): void {
		const next = resolveMotionTier(this.#env, this.#setting);
		if (next === this.#tier) return;
		this.#tier = next;
		for (const listener of [...this.#listeners]) {
			listener(next);
		}
	}
}
