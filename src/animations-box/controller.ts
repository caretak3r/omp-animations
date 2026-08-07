/**
 * Animations Box — controller.
 *
 * Owns a FRESH `CacheMeterState` instance — never `CacheMeterController`'s own
 * instance, and never `CacheMeterController` itself. That controller only
 * ever constructs its animated `CacheMeterWidget` (where the hit-rate ease and
 * invalidation-alert blink live, see `../cache-meter/widget.ts`) from inside
 * the very `ctx.ui.setWidget(...)` factory callback this box must never
 * invoke — reusing it unmodified would either silently mount a second, real
 * standalone Cache Meter widget (defeating "stop mounting the standalone
 * row"), or require threading a "suppress but still construct my widget
 * somewhere else" seam through an existing module, a much larger, riskier
 * change than this bead calls for (Plan 017 Decision 6). `CacheMeterState` is
 * the actual unit of reuse: this controller calls its public API exactly as
 * `CacheMeterController` does, and hands the resulting snapshot to
 * `segments.ts`'s `buildCacheMeterSegment`, which in turn calls Cache Meter's
 * own exported pure `renderCacheMeterRow`. Net effect: the hit-rate ease and
 * invalidation blink are the one piece of per-widget cosmetic behavior this
 * box does not reproduce (see `segments.ts`'s own doc) — the ledger
 * accounting itself comes through unmodified.
 *
 * Cache Meter (`oh-my-pi-dxi.2`), Audit Trail, Tool Constellation and
 * Palimpsest (`oh-my-pi-dxi.3`) are wired here the same way: a fresh `*State`
 * instance owned by this controller, fed by event handlers that reproduce
 * each standalone controller's own adapter logic where it isn't exported
 * (`applyPalimpsestTouch`/`isEditToolResult` below mirror
 * `../palimpsest/controller.ts`'s private helpers of the same names, exactly
 * as `toCacheRequestSample` above mirrors cache meter's). Audit Trail's own
 * second surface — the alarm `setStatus` line — is deliberately NOT ported
 * here (Plan 017 Decision 6): only its ledger state feeds the box, so
 * `AuditLedgerState` never sees the divergence probe's `noteProbe` either
 * (that's off-path filesystem I/O the standalone controller owns alongside
 * its `setStatus` surface, not "row/ledger state"). Cadence Equalizer,
 * Rate-Limit Tidepool and Reflection Ripple land in `dxi.4`; the breathing
 * border in `dxi.5`. Registrar wiring — actually mounting this controller
 * from `session_start` — is `dxi.7`'s scope; this controller is fully
 * unit-testable in isolation until then.
 */
import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	AutoCompactionStartEvent,
	EditToolResultEvent,
	MessageEndEvent,
	ToolCallEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { getDiffStats } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { AuditLedgerState, auditTouchesFromToolResult } from "../audit-trail-box";
import { CacheMeterState, type CacheRequestSample } from "../cache-meter";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { PalimpsestState, parseHunkSpans } from "../palimpsest";
import { ConstellationState } from "../tool-constellation";
import {
	type BoxTheme,
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildPalimpsestSegment,
	buildToolConstellationSegment,
	type SegmentSample,
} from "./segments";
import { type AnimationsBoxConfig, segmentActive } from "./settings";
import { AnimationsBoxWidget } from "./widget";

/** Namespaced per the native-vs-plugin key-collision memory — never a keeper's own `WIDGET_KEY` (only 2 of 8 even export theirs). */
export const BOX_WIDGET_KEY = "oh-my-pi-animations-box";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Narrow a finalized `message_end` event to the provider/model/usage triple the ledger needs — identical to `../cache-meter/controller.ts`'s own private helper of the same name. */
function toCacheRequestSample(message: MessageEndEvent["message"]): CacheRequestSample | undefined {
	if (message.role !== "assistant") return undefined;
	return {
		provider: message.provider,
		model: message.model,
		usage: {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			totalTokens: message.usage.totalTokens,
			cost: message.usage.cost,
			cttl: message.usage.cttl,
		},
	};
}

/** Narrow a tool-result event to the built-in `edit` tool — identical to `../palimpsest/controller.ts`'s own private helper of the same name. */
function isEditToolResult(event: ToolResultEvent): event is EditToolResultEvent {
	return event.toolName === "edit";
}

/** One file's touch, normalized from either a single-file `EditToolDetails` or one entry of a multi-file `perFileResults` — identical shape to `../palimpsest/controller.ts`'s own private `FileTouch`, not exported from that module's barrel. */
interface PalimpsestFileTouch {
	readonly path: string | undefined;
	readonly sourcePath: string | undefined;
	readonly op: "create" | "delete" | "update" | undefined;
	readonly diff: string | undefined;
	readonly snapshotsPruned: boolean | undefined;
	readonly isError: boolean | undefined;
}

/** Apply one file's touch to the Palimpsest ledger — identical to `../palimpsest/controller.ts`'s own private `applyFileTouch`, not exported from that module's barrel (same precedent as `toCacheRequestSample` above). */
function applyPalimpsestTouch(state: PalimpsestState, touch: PalimpsestFileTouch): void {
	if (touch.isError || !touch.path) return;
	if (touch.op === "delete") {
		state.onDelete(touch.path);
		return;
	}
	if (touch.sourcePath && touch.sourcePath !== touch.path) {
		state.onRename(touch.sourcePath, touch.path);
	}
	if (touch.op === "create") {
		state.onCreate(touch.path);
	}

	const diff = touch.diff;
	if (!diff) return;
	if (touch.snapshotsPruned) {
		state.applyDegradedTouch(touch.path);
		return;
	}
	const spans = parseHunkSpans(diff);
	if (spans.length === 0) {
		const { added, removed } = getDiffStats(diff);
		if (added === 0 && removed === 0) return; // a genuine no-op (e.g. a pure rename) — nothing to record
		state.applyDegradedTouch(touch.path); // a real change with no parseable hunk header — never guess spans
		return;
	}
	state.applySpans(touch.path, spans);
}

/**
 * The {@link AnimationHost} backpressure field must be wired at construction,
 * before the widget factory supplies the real `tui` — this adapter lets the
 * host read a live signal once {@link attach} runs from inside that factory.
 * Identical to every other controller's own copy in this package.
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

/** Per-event surface the controller needs — decoupled from the full `ExtensionContext` for unit-testability, same convention as every other controller in this package. */
export interface AnimationsBoxContext {
	/** False in print/RPC modes with no widget surface — every segment stays fully dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** Current working directory, for resolving the relative paths Audit Trail's `tool_result` adapter tracks. */
	cwd: string;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface AnimationsBoxControllerOptions {
	scheduler?: FrameScheduler;
	placement?: WidgetPlacement;
	motionSetting?: MotionSetting;
	/** Wire-time initial config, from the registrar's synchronous settings read (`dxi.7`). */
	initialConfig: AnimationsBoxConfig;
}

/** Drives the Animations Box. See the module doc above for why this owns a fresh `CacheMeterState` rather than delegating to `CacheMeterController`. */
export class AnimationsBoxController {
	#scheduler: FrameScheduler;
	#widgetOptions: ExtensionWidgetOptions;
	#motionSetting: MotionSetting;

	#config: AnimationsBoxConfig;
	#mount: { host: AnimationHost } | undefined;

	#cacheMeterState: CacheMeterState = new CacheMeterState();
	#auditTrailState: AuditLedgerState = new AuditLedgerState();
	#constellationState: ConstellationState = new ConstellationState();
	#palimpsestState: PalimpsestState = new PalimpsestState();

	constructor(options: AnimationsBoxControllerOptions) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#motionSetting = options.motionSetting ?? "full";
		this.#config = options.initialConfig;
	}

	/** Live-resolved box config — read-only accessor for tests/introspection. */
	get config(): AnimationsBoxConfig {
		return this.#config;
	}

	/** Mount the box widget once, unconditionally. Idempotent; stays dormant with no UI surface. */
	mount(ctx: AnimationsBoxContext): void {
		if (this.#mount || !ctx.hasUI) return;

		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, this.#motionSetting);
		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const scheduler = this.#scheduler;

		ctx.setWidget(
			BOX_WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new AnimationsBoxWidget({
					tui,
					host,
					policy,
					theme,
					clock: scheduler,
					onTick: now => this.#onTick(now),
					buildSamples: now => this.#buildSamples(now, theme),
					getDetail: () => this.#config.detail,
				});
			},
			this.#widgetOptions,
		);
		this.#mount = { host };
	}

	/** Seam for future per-tick state mutation (cadence sampling, ripple settle, ...) — no-op until a later bead wires a segment that needs one. */
	#onTick(_now: number): void {}

	#buildSamples(now: number, theme: BoxTheme): readonly SegmentSample[] {
		// Priority order, not builder-list order — this array feeds detailed mode's
		// row-per-segment loop directly (see `widget.ts`), which does not sort by
		// priority itself. `dxi.4`'s cadenceEqualizer (pri 2) / rateLimitTidepool
		// (pri 4) / reflectionRipple (pri 7) slot in between these on landing.
		const all: readonly SegmentSample[] = [
			buildCacheMeterSegment(this.#cacheMeterState, now, theme),
			buildAuditTrailBoxSegment(this.#auditTrailState, now, theme),
			buildToolConstellationSegment(this.#constellationState, now, theme),
			buildPalimpsestSegment(this.#palimpsestState, now, theme),
		];
		return all.filter(s => segmentActive(this.#config, s.id));
	}

	/** `message_end`: feed a finalized assistant response's prompt-cache usage into the ledger. */
	onMessageEnd(event: MessageEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		const sample = toCacheRequestSample(event.message);
		if (sample === undefined) return;
		this.#cacheMeterState.recordUsage(sample, this.#scheduler.now());
	}

	/**
	 * `tool_result`: Audit Trail's read/write ledger and Palimpsest's edit-span
	 * ledger both derive from tool results, so one handler feeds both, exactly
	 * as each standalone controller's own `tool_result` subscription would.
	 */
	onToolResult(event: ToolResultEvent, ctx: Pick<AnimationsBoxContext, "hasUI" | "cwd">): void {
		if (!ctx.hasUI) return;
		for (const touch of auditTouchesFromToolResult(event, ctx.cwd)) {
			if (touch.kind === "read") this.#auditTrailState.noteRead(touch.path, touch.observed);
			else this.#auditTrailState.noteWrite(touch.path, this.#scheduler.now(), touch.observed);
		}

		if (!isEditToolResult(event)) return;
		const details = event.details;
		if (!details) return; // a thrown-error result always carries `details: undefined`
		if (details.perFileResults && details.perFileResults.length > 0) {
			for (const file of details.perFileResults) {
				applyPalimpsestTouch(this.#palimpsestState, {
					path: file.path,
					sourcePath: file.sourcePath,
					op: file.op,
					diff: file.diff,
					snapshotsPruned: file.snapshotsPruned,
					isError: file.isError,
				});
			}
		} else {
			applyPalimpsestTouch(this.#palimpsestState, {
				path: details.path,
				sourcePath: details.sourcePath,
				op: details.op,
				diff: details.diff,
				snapshotsPruned: details.snapshotsPruned,
				isError: undefined,
			});
		}
	}

	/** `tool_call`: fire (or refresh) Tool Constellation's star for this tool. */
	onToolCall(event: ToolCallEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#constellationState.recordFire(event.toolName, this.#scheduler.now());
	}

	/**
	 * `turn_end`: Audit Trail's cold-eviction sweep and Palimpsest's region fade
	 * clock both advance on turn boundaries.
	 */
	onTurnEnd(event: TurnEndEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#auditTrailState.noteTurn();
		this.#palimpsestState.advanceTurn(event.turnIndex);
	}

	/** `session_compact`: attribute a nearby cache invalidation to this compaction, and correlate any recent Audit Trail poison flag with the user's recovery. */
	onSessionCompact(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("compact", this.#scheduler.now());
		this.#auditTrailState.noteRecovery(this.#scheduler.now());
	}

	/** `auto_compaction_start`: same cache-invalidation attribution, distinct cause. */
	onAutoCompactionStart(_event: AutoCompactionStartEvent, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState.recordEvent("auto-compact", this.#scheduler.now());
	}

	/** `auto_compaction_end`: Audit Trail's own recovery-correlation signal — a distinct event from `onAutoCompactionStart`'s cache attribution above. */
	onAutoCompactionEnd(ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#auditTrailState.noteRecovery(this.#scheduler.now());
	}

	/**
	 * `session_switch`: reset Cache Meter's ledger to a fresh, empty state —
	 * mirroring `CacheMeterController`'s own `session_switch` -> `dispose()`
	 * wiring, without tearing down the box's own mount (Decision 6 — other
	 * segments may be unconditionally mounted and should keep showing
	 * immediately in the new session). Audit Trail's own `session_switch`
	 * wiring drops its working set the same way, via its state's own
	 * `noteSessionSwitch` (counting any still-POISONED/DIRTY path as a
	 * teardown leak) rather than a fresh instance. Tool Constellation and
	 * Palimpsest wire no `session_switch` handler at all in their own
	 * standalone extensions, so their state is deliberately left untouched
	 * here too.
	 */
	onSessionSwitch(_event: unknown, ctx: Pick<AnimationsBoxContext, "hasUI">): void {
		if (!ctx.hasUI) return;
		this.#cacheMeterState = new CacheMeterState();
		this.#auditTrailState.noteSessionSwitch();
	}

	/** Tear down the live mount: dispose the host and clear the widget. Idempotent. */
	dispose(ctx: Pick<AnimationsBoxContext, "setWidget">): void {
		if (!this.#mount) return;
		this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(BOX_WIDGET_KEY, undefined, this.#widgetOptions);
	}
}
