import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { createFileProbeSource, DiskProbe, type ProbeSource } from "./probe";
import { buildRemedyPlan, type RemedyOptions, type RemedyPlan } from "./remedy";
import { AuditLedgerState, type AuditSnapshot, type TouchObservation } from "./state";
import {
	type AuditPanelOptions,
	type AuditTrailBoxColors,
	type AuditTrailBoxTheme,
	AuditTrailBoxWidget,
	auditColors,
	renderAuditMeterRow,
	renderAuditOffText,
	renderAuditPanel,
} from "./widget";

export const WIDGET_KEY = "audit-trail-box";
/** Footer status key. Distinct from {@link WIDGET_KEY} so clearing one never clears the other. */
export const STATUS_KEY = "audit-trail-box-alarm";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Minimum gap between disk-divergence probe ticks. */
export const PROBE_INTERVAL_MS = 5_000;

/** Share of the terminal the footer status line may claim — the footer is shared with everything else in it. */
export const STATUS_WIDTH_SHARE = 0.3;

/** Floor for the status budget, so the single-count tier always has room. */
export const MIN_STATUS_WIDTH = 10;

/** Assumed terminal width when the host reports none (non-TTY, detached, resize race). */
export const DEFAULT_TERMINAL_COLUMNS = 80;

/** Columns the footer meter may use, given the terminal width. */
export function statusWidthFor(columns?: number): number {
	const total = columns !== undefined && Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_TERMINAL_COLUMNS;
	return Math.max(MIN_STATUS_WIDTH, Math.floor(total * STATUS_WIDTH_SHARE));
}

/**
 * Per-event surface the controller needs, adapted from the extension
 * `ExtensionContext` at the call site so the controller stays unit-testable with
 * a plain object.
 */
export interface AuditTrailBoxContext {
	/** False in print/RPC modes with no widget surface — the tracker stays fully dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: AuditTrailBoxTheme;
	/** Terminal width, for the footer status line's width tiers. */
	columns?: number;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface AuditTrailBoxControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	accentColor?: ThemeColor;
	/** Filesystem seam for the divergence probe. Defaults to the real one. */
	probeSource?: ProbeSource;
	/** Minimum gap between probe ticks. Defaults to {@link PROBE_INTERVAL_MS}. */
	probeIntervalMs?: number;
	/** Paths inspected per probe tick. Defaults to the probe's own batch size. */
	probeBatchSize?: number;
}

type Mount = { mode: "animated"; host: AnimationHost; policy: MotionPolicy } | { mode: "static" };

/**
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 */
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: object): void } {
	let live: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return live?.underPressure ?? false;
			},
		},
		attach(tui) {
			live = backpressureFromTui(tui);
		},
	};
}

/** Whether anything in the working set has cleared the >=2-family severity gate or gone outright poisoned. */
function isAlarming(snapshot: AuditSnapshot): boolean {
	if (snapshot.counts.poisoned > 0) return true;
	return snapshot.paths.some(record => record.severity === "alarm");
}

/**
 * Drives Audit Trail Box: owns the {@link AuditLedgerState}, the off-path
 * {@link DiskProbe}, and the two live surfaces.
 *
 * **Surfaces.** The ambient one is the widget: an animated compact meter in the
 * `subtle`/`full` tiers, and — mirroring every other animation in the suite — a
 * single static text line in the `off` tier, repainted on each event because
 * there is no frame clock in that mode. The second is `setStatus`, and it is
 * deliberately *not* a copy of the widget: it appears only while something has
 * cleared the >=2-family severity gate (or gone outright POISONED) and clears
 * itself the moment that stops being true. Painting the same meter twice on
 * every screen would be noise; a footer line that shows up only when the agent
 * is about to act on a stale copy is the escalation the meter cannot make on its
 * own. Both go through the same width-tiered renderer, so the footer degrades to
 * a single count exactly like the widget does.
 *
 * **Probing.** Ticks are event-triggered rather than timer-driven: any tracked
 * event may kick a round-robin batch, rate-limited to one tick per
 * {@link PROBE_INTERVAL_MS} and guarded against overlap. This is still off-path
 * from the agent's own reads — the read of file A is what probes files B..G, and
 * a path's own read resets its baseline before the probe ever sees it — and it
 * costs no background timer, so extension teardown cannot leak one.
 *
 * **Dormancy.** Every entry point returns immediately when `ctx.hasUI` is false.
 * Not just the drawing: the ledger itself never advances, because tracking a
 * working set nobody can see is pure overhead in print/RPC mode.
 */
export class AuditTrailBoxController {
	#scheduler: FrameScheduler;
	#state = new AuditLedgerState();
	#probe: DiskProbe;
	#probeIntervalMs: number;
	#probeInFlight = false;
	#lastProbeMs = Number.NEGATIVE_INFINITY;
	#pendingProbe: Promise<void> = Promise.resolve();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#colors: AuditTrailBoxColors;
	#accentColor: ThemeColor | undefined;
	#statusShown = false;

	constructor(options: AuditTrailBoxControllerOptions = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
		this.#colors = auditColors(options.accentColor);
		this.#probe = new DiskProbe(options.probeSource ?? createFileProbeSource(), {
			batchSize: options.probeBatchSize,
		});
		this.#probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): AuditLedgerState {
		return this.#state;
	}

	/** Resolves once the fire-and-forget probe tick an event may have kicked has been applied. */
	async settled(): Promise<void> {
		await this.#pendingProbe;
	}

	/** The agent read a path (`read` tool result, or a `bash` command that dumped a file). */
	noteRead(path: string, observed: TouchObservation, ctx: AuditTrailBoxContext): void {
		if (!ctx.hasUI) return;
		this.#state.noteRead(path, observed);
		this.#refresh(ctx);
		this.#maybeProbe(ctx);
	}

	/** The agent wrote a path (`write` or `edit`). */
	noteWrite(path: string, observed: TouchObservation, ctx: AuditTrailBoxContext): void {
		if (!ctx.hasUI) return;
		this.#state.noteWrite(path, this.#scheduler.now(), observed);
		this.#refresh(ctx);
		this.#maybeProbe(ctx);
	}

	/** A turn boundary: sweep cold-eviction candidates. */
	noteTurn(ctx: AuditTrailBoxContext): void {
		if (!ctx.hasUI) return;
		this.#state.noteTurn();
		this.#refresh(ctx);
		this.#maybeProbe(ctx);
	}

	/** A `/compact` or `/clear` landed — correlate it with any recent poison flag. */
	noteRecovery(ctx: AuditTrailBoxContext): void {
		if (!ctx.hasUI) return;
		this.#state.noteRecovery(this.#scheduler.now());
		this.#refresh(ctx);
	}

	/** Session switch: drop the working set, counting any unresolved path as a teardown leak. */
	noteSessionSwitch(ctx: AuditTrailBoxContext): void {
		if (!ctx.hasUI) return;
		this.#state.noteSessionSwitch();
		this.#refresh(ctx);
	}

	/** One round-robin probe tick, ignoring the rate limit. Still skipped while a tick is in flight. */
	async probeNow(ctx: AuditTrailBoxContext): Promise<void> {
		if (!ctx.hasUI || this.#probeInFlight) return;
		const paths = this.#trackedPaths();
		if (paths.length === 0) return;
		this.#probeInFlight = true;
		this.#lastProbeMs = this.#scheduler.now();
		try {
			const readings = await this.#probe.tick(paths);
			this.#state.noteProbe(readings, this.#scheduler.now());
		} finally {
			this.#probeInFlight = false;
		}
		this.#refresh(ctx);
	}

	/**
	 * The headline remedy. Re-reads every must-re-read path from disk *first*, so
	 * the plan's diffs compare the copy the agent still holds against what is
	 * actually there now — the whole point is that the stale copy is described
	 * before it is discarded, not after. Paths inside their post-flag cooldown are
	 * still re-read here: the cooldown suppresses re-escalation, not observation.
	 */
	async remedy(ctx: AuditTrailBoxContext, options: RemedyOptions = {}): Promise<RemedyPlan> {
		const stale = this.#state
			.snapshot()
			.paths.filter(record => record.status === "poisoned" || record.status === "dirty")
			.map(record => record.path);
		if (stale.length > 0) {
			const readings = await this.#probe.probe(stale);
			this.#state.noteProbe(readings, this.#scheduler.now());
			if (ctx.hasUI) this.#refresh(ctx);
		}
		return buildRemedyPlan(this.#state.snapshot(), options);
	}

	/** The slash command's panel: the whole working set as a risk-sorted table. */
	panel(ctx: AuditTrailBoxContext, options: AuditPanelOptions = {}): readonly string[] {
		return renderAuditPanel(this.#state.snapshot(), ctx.theme, { colors: this.#colors, ...options });
	}

	/**
	 * Tear down the live mount and clear both surfaces. Also records the teardown
	 * against the ledger, so a shutdown that discards still-unresolved paths counts
	 * as the teardown leak the tracker is supposed to notice. Idempotent.
	 */
	dispose(ctx: Pick<AuditTrailBoxContext, "setWidget" | "setStatus">): void {
		this.#state.noteSessionSwitch();
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
		ctx.setStatus(STATUS_KEY, undefined);
		this.#statusShown = false;
	}

	#trackedPaths(): readonly string[] {
		return this.#state.snapshot().paths.map(record => record.path);
	}

	/**
	 * Kick a probe tick if the rate limit allows it. Fire-and-forget: nothing
	 * downstream awaits divergence, and a probe source that throws must degrade to
	 * "no reading this tick" rather than take the host down with it.
	 */
	#maybeProbe(ctx: AuditTrailBoxContext): void {
		if (this.#probeInFlight) return;
		if (this.#scheduler.now() - this.#lastProbeMs < this.#probeIntervalMs) return;
		this.#pendingProbe = this.probeNow(ctx).catch(() => {});
	}

	#refresh(ctx: AuditTrailBoxContext): void {
		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
		} else if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderAuditOffText(this.#state.snapshot())], this.#widgetOptions);
		}
		// Animated mode: the widget's own frame subscription re-renders from the shared state.
		this.#refreshStatus(ctx);
	}

	#refreshStatus(ctx: AuditTrailBoxContext): void {
		// The `off` tier already says everything on its static widget line; a second
		// static line in the footer would just be the same counts twice.
		const policy = this.#mount?.mode === "animated" ? this.#mount.policy : undefined;
		const snapshot = this.#state.snapshot();
		if (policy === undefined || !isAlarming(snapshot)) {
			if (!this.#statusShown) return;
			ctx.setStatus(STATUS_KEY, undefined);
			this.#statusShown = false;
			return;
		}
		const tier = policy.tier === "full" ? "full" : "subtle";
		const row = renderAuditMeterRow(
			snapshot,
			statusWidthFor(ctx.columns),
			this.#scheduler.now(),
			ctx.theme,
			tier,
			this.#colors,
		);
		ctx.setStatus(STATUS_KEY, row);
		this.#statusShown = true;
	}

	#mountWidget(ctx: AuditTrailBoxContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderAuditOffText(this.#state.snapshot())], this.#widgetOptions);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		const clock = this.#scheduler;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new AuditTrailBoxWidget({
					tui,
					host,
					policy,
					state,
					theme,
					clock,
					accentColor: this.#accentColor,
				});
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host, policy };
	}
}
