import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	EditToolResultEvent,
	ToolResultEvent,
	TurnEndEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getDiffStats } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import type { BackpressureSignal, FrameScheduler, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, DEFAULT_FRAME_SCHEDULER, MotionPolicy } from "../kit";
import { GLOW_THRESHOLD, parseHunkSpans } from "./spans";
import { PalimpsestState } from "./state";
import { type PalimpsestTheme, PalimpsestWidget, renderPalimpsestRows, resolvePalimpsestColors } from "./widget";

const WIDGET_KEY = "palimpsest";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

/** Narrow a tool-result event to the built-in `edit` tool, matching the same assertion Diff Bloom's `isEditToolResult` makes (the `toolName` discriminant alone can't exclude `CustomToolResultEvent`). */
function isEditToolResult(event: ToolResultEvent): event is EditToolResultEvent {
	return event.toolName === "edit";
}

/** One file's touch, normalized from either a single-file `EditToolDetails` or one entry of a multi-file `perFileResults`. */
interface FileTouch {
	readonly path: string | undefined;
	readonly sourcePath: string | undefined;
	readonly op: "create" | "delete" | "update" | undefined;
	readonly diff: string | undefined;
	readonly snapshotsPruned: boolean | undefined;
	readonly isError: boolean | undefined;
}

/**
 * Apply one file's touch to the ledger. Order matters: delete short-circuits
 * (nothing else to do once the file's gone); a rename migrates the ledger
 * entry before anything about the destination's content is recorded; a
 * fresh create resets whatever the path used to carry. Only after that does
 * the touch's own diff get parsed into spans — degrading to path-level
 * counting (never guessing) whenever `snapshotsPruned` is set or the diff
 * carries a real change with no parseable hunk header.
 */
function applyFileTouch(state: PalimpsestState, touch: FileTouch): void {
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
 * The `off`-tier content: the same rows/sort/cap {@link renderPalimpsestRows}
 * always produces, frozen at its `subtle` (static, no pulse) style —
 * `elapsedMs` is irrelevant here since `renderPalimpsestRows` only reads it
 * for the `full`-tier ember pulse. Spread into a fresh mutable array: the
 * `ExtensionWidgetContent` plain-content variant is `string[]`, not the
 * `readonly string[]` the renderer returns.
 */
function renderOffContent(
	state: PalimpsestState,
	theme: PalimpsestTheme,
	accentColor: ThemeColor | undefined,
): string[] {
	return [...renderPalimpsestRows(state.snapshot(), 0, theme, "subtle", resolvePalimpsestColors(accentColor))];
}

/**
 * Per-event surface the controller needs. Adapted from the extension
 * `ExtensionContext` at the call site so the controller stays decoupled from
 * the full context (and unit-testable with a plain object).
 */
export interface PalimpsestContext {
	/** False in print/RPC modes with no widget surface — the field stays dormant. */
	hasUI: boolean;
	/** Whether stdout is a TTY (a hard gate on motion). */
	isTTY: boolean;
	/** Environment for `NO_COLOR`/`CI`/`TERM` gates; defaults to `Bun.env` when omitted. */
	env?: Record<string, string | undefined>;
	/** The resolved `animations` setting. */
	motionSetting: MotionSetting;
	theme: PalimpsestTheme;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

type Mount = { mode: "animated"; host: AnimationHost } | { mode: "off" };

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

/**
 * Drives Palimpsest: every `edit` `tool_result` feeds {@link applyFileTouch}
 * (single-file `details` or, for a multi-file edit, every entry of
 * `details.perFileResults`); every `turn_end` advances the ledger's fade
 * clock. Unlike the rest of the family, mount/unmount is driven by
 * *visibility* rather than by "has anything happened yet": the widget mounts
 * the first time a touch pushes some region's overlap count to 2, and tears
 * all the way back down (host disposed, widget removed) the moment nothing
 * in the ledger is visible any more — whether because every region faded out
 * via {@link PalimpsestState.advanceTurn} or, in principle, because the
 * ledger itself emptied. A quiet session that never re-touches the same
 * region twice never mounts anything at all. Motion gating goes through the
 * shared kit's {@link MotionPolicy}; a resolved tier of `off` still mounts
 * — as plain static content ({@link renderOffContent}) rather than an
 * animated widget — whenever there's something visible to show, refreshed
 * directly by the controller on every event since there's no frame clock in
 * that mode; `off` and "nothing to show" only render identically when the
 * ledger genuinely has nothing to show.
 */
export class PalimpsestController {
	#scheduler: FrameScheduler;
	#state = new PalimpsestState();
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#accentColor: ThemeColor | undefined;

	constructor(options: { scheduler?: FrameScheduler; placement?: WidgetPlacement; accentColor?: ThemeColor } = {}) {
		this.#scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
	}

	/** Read-only state accessor for tests/introspection. */
	get state(): PalimpsestState {
		return this.#state;
	}

	onToolResult(event: ToolResultEvent, ctx: PalimpsestContext): void {
		if (!ctx.hasUI) return;
		if (!isEditToolResult(event)) return;
		const details = event.details;
		if (!details) return; // a thrown-error result always carries `details: undefined`

		if (details.perFileResults && details.perFileResults.length > 0) {
			for (const file of details.perFileResults) {
				applyFileTouch(this.#state, {
					path: file.path,
					sourcePath: file.sourcePath,
					op: file.op,
					diff: file.diff,
					snapshotsPruned: file.snapshotsPruned,
					isError: file.isError,
				});
			}
		} else {
			applyFileTouch(this.#state, {
				path: details.path,
				sourcePath: details.sourcePath,
				op: details.op,
				diff: details.diff,
				snapshotsPruned: details.snapshotsPruned,
				isError: undefined,
			});
		}
		this.#refresh(ctx);
	}

	onTurnEnd(event: TurnEndEvent, ctx: PalimpsestContext): void {
		if (!ctx.hasUI) return;
		this.#state.advanceTurn(event.turnIndex);
		this.#refresh(ctx);
	}

	/** Tear down any live mount (animated host, if one exists) and clear the widget. Idempotent. */
	dispose(ctx: Pick<PalimpsestContext, "setWidget">): void {
		this.#teardown(ctx);
	}

	/**
	 * Mount once something becomes visible, tear down once nothing is. An
	 * already-mounted `animated` widget picks up ledger mutations on its own
	 * next frame tick and needs no explicit refresh; an already-mounted `off`
	 * widget has no frame clock, so the controller re-pushes its static
	 * content directly on every event that leaves it still visible.
	 */
	#refresh(ctx: PalimpsestContext): void {
		const hasVisibleRows = this.#state.snapshot().rows.some(row => row.overlapCount >= GLOW_THRESHOLD);
		if (hasVisibleRows && !this.#mount) {
			this.#mount = this.#mountWidget(ctx);
			return;
		}
		if (!hasVisibleRows && this.#mount) {
			this.#teardown(ctx);
			return;
		}
		if (hasVisibleRows && this.#mount?.mode === "off") {
			ctx.setWidget(WIDGET_KEY, renderOffContent(this.#state, ctx.theme, this.#accentColor), this.#widgetOptions);
		}
	}

	#teardown(ctx: Pick<PalimpsestContext, "setWidget">): void {
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
		this.#mount = undefined;
	}

	#mountWidget(ctx: PalimpsestContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, renderOffContent(this.#state, ctx.theme, this.#accentColor), this.#widgetOptions);
			return { mode: "off" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#scheduler });
		const state = this.#state;
		ctx.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				backpressure.attach(tui);
				return new PalimpsestWidget({ tui, host, policy, state, theme, accentColor: this.#accentColor });
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host };
	}
}
