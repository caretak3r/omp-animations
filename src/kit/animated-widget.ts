import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { AnimationHost } from "./animation-host";
import type { MotionPolicy } from "./motion-policy";

/** The slice of `TUI` an {@link AnimatedWidget} needs: scoped repaint only. */
export type AnimatedWidgetHost = Pick<TUI, "requestComponentRender">;

export interface AnimatedWidgetOptions {
	/**
	 * The `tui` handed to the widget factory. Held for scoped repaints via
	 * `tui.requestComponentRender(this)` (TUI method, not `ctx.ui`).
	 */
	tui: AnimatedWidgetHost;
	/** Shared frame clock this widget subscribes to while mounted. */
	host: AnimationHost;
	/** Motion policy. Tier `off` renders one static frame; live tier changes start/stop animation without a remount. */
	policy: MotionPolicy;
	/**
	 * Called once, with the first error {@link renderFrame} or {@link onFrame}
	 * throws. By then the widget has already detached from the frame clock and
	 * the policy; every later {@link render} returns {@link renderFailure}.
	 */
	onRenderError?: (error: unknown) => void;
}

/** Compare two row arrays for byte-identical content. */
function rowsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Base `Component` for ambient animated widgets. It owns the shared lifecycle so
 * each concrete widget is just "a pure model + a renderer":
 *
 * - On construction it subscribes to the {@link MotionPolicy} and syncs the
 *   frame-clock subscription with the resolved tier: `off` renders one static
 *   frame; live off<->on crossings start/stop the {@link AnimationHost}
 *   subscription without a remount.
 * - Each frame it advances `elapsedMs`, calls the overridable {@link onFrame}
 *   hook, then re-renders at the last known width and — only if the rendered rows
 *   changed — requests a component-scoped repaint via
 *   `tui.requestComponentRender(this)`.
 * - `dispose()` unsubscribes from both the host and the policy and is idempotent
 *   (no leaked subscriber).
 *
 * Subclasses implement {@link renderFrame} to produce rows from their state and
 * the current phase (`this.elapsedMs`).
 */
export abstract class AnimatedWidget implements Component {
	#tui: AnimatedWidgetHost;
	#host: AnimationHost;
	#policy: MotionPolicy;
	#unsubscribe: (() => void) | undefined;
	#unsubscribePolicy: (() => void) | undefined;
	#disposed = false;
	#elapsedMs = 0;
	#lastWidth: number | undefined;
	#lastRows: readonly string[] = [];
	#failure: { readonly error: unknown } | undefined;
	#onRenderError: ((error: unknown) => void) | undefined;

	constructor(options: AnimatedWidgetOptions) {
		this.#tui = options.tui;
		this.#host = options.host;
		this.#policy = options.policy;
		this.#onRenderError = options.onRenderError;
		if (this.#policy.tier !== "off") {
			this.#subscribeToHost();
		}
		// Live tier changes: start/stop the frame-clock subscription when the tier
		// crosses off<->on. subtle<->full is cadence-only and the host handles it.
		this.#unsubscribePolicy = this.#policy.subscribe(() => this.#syncToTier());
	}

	/** Milliseconds elapsed since the host started — the animation phase. */
	get elapsedMs(): number {
		return this.#elapsedMs;
	}

	/** Whether this widget is subscribed to the frame clock. */
	get animating(): boolean {
		return this.#unsubscribe !== undefined;
	}

	/**
	 * Render the widget's rows at `width` for the current phase (`this.elapsedMs`).
	 * Must be a pure function of the widget's state and phase. Called both by the
	 * TUI and internally by the frame loop, so it must not mutate lifecycle state.
	 */
	abstract renderFrame(width: number): readonly string[];

	/**
	 * Overridable per-frame hook, called before the re-render/diff. Advance model
	 * state here; leave the actual drawing to {@link renderFrame}. Default no-op.
	 */
	onFrame(_elapsedMs: number): void {}

	/**
	 * Rows to show once a render has thrown. Default: nothing — the widget
	 * disappears rather than freezing on stale numbers. Subclasses may return one
	 * line naming the failure. Must not throw; if it does, the widget shows nothing.
	 */
	renderFailure(_width: number, _error: unknown): readonly string[] {
		return [];
	}

	/** {@link Component} entrypoint. Caches rows per width so the frame loop can diff cheaply. */
	render(width: number): readonly string[] {
		if (this.#failure !== undefined) {
			try {
				return this.renderFailure(width, this.#failure.error);
			} catch {
				return [];
			}
		}
		if (width === this.#lastWidth) return this.#lastRows;
		this.#lastWidth = width;
		try {
			this.#lastRows = this.renderFrame(width);
		} catch (error) {
			this.#fail(error);
			return this.render(width);
		}
		return this.#lastRows;
	}

	/**
	 * Invalidate the width-keyed render cache so the next {@link render} recomputes
	 * from current state. Call after the widget's state changes *between* frames —
	 * e.g. an event-driven refresh, or any change while the `off` tier is active and
	 * the frame loop is not running. Without it, {@link render} would return the
	 * cached rows for the last width and the external change would not be drawn.
	 * (The frame loop already re-renders each tick, so animating tiers do not need
	 * this; it is the seam that lets a non-timer, off-tier-static widget update.)
	 */
	markDirty(): void {
		this.#lastWidth = undefined;
	}

	/** Invalidate cached rows and request one scoped repaint for externally-mutated state. */
	requestRender(): void {
		if (this.#disposed) return;
		this.markDirty();
		this.#tui.requestComponentRender(this);
	}

	/** Lifecycle teardown: unsubscribe from the frame clock AND the policy. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#unsubscribePolicy?.();
		this.#unsubscribePolicy = undefined;
	}

	#subscribeToHost(): void {
		this.#unsubscribe = this.#host.subscribe((_frame, elapsedMs) => this.#handleFrame(elapsedMs));
	}

	/**
	 * Reconcile the frame-clock subscription with the live policy tier. Runs on
	 * every resolved-tier change; only an off<->on crossing changes the
	 * subscription. On a crossing, invalidate the render cache ({@link markDirty})
	 * and request a scoped repaint so the switch is visible immediately; in
	 * particular, a widget flipped to `off` settles on exactly one static frame.
	 */
	#syncToTier(): void {
		if (this.#disposed) return;
		const shouldAnimate = this.#policy.tier !== "off";
		if (shouldAnimate === (this.#unsubscribe !== undefined)) return;
		if (shouldAnimate) {
			this.#subscribeToHost();
		} else {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
		}
		this.markDirty();
		this.#tui.requestComponentRender(this);
	}

	#handleFrame(elapsedMs: number): void {
		if (this.#disposed) return;
		this.#elapsedMs = elapsedMs;
		try {
			this.onFrame(elapsedMs);
			const width = this.#lastWidth;
			if (width === undefined) {
				// Not laid out yet: request an initial paint; render() will produce rows.
				this.#tui.requestComponentRender(this);
				return;
			}
			const next = this.renderFrame(width);
			if (rowsEqual(next, this.#lastRows)) return;
			this.#lastRows = next;
		} catch (error) {
			this.#fail(error);
		}
		this.#tui.requestComponentRender(this);
	}

	/**
	 * A throw from the frame loop would surface as an uncaught exception in the
	 * host's timer and end the whole session; a throw from {@link render} would
	 * do the same inside the TUI's paint. A decorative widget must not have that
	 * blast radius: detach from the clock and the policy first, so a throwing
	 * error callback cannot re-enter, then report once and stay failed.
	 */
	#fail(error: unknown): void {
		if (this.#failure !== undefined) return;
		this.#failure = { error };
		this.#lastRows = [];
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#unsubscribePolicy?.();
		this.#unsubscribePolicy = undefined;
		this.#onRenderError?.(error);
	}
}
