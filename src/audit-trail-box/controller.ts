import type {
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AccentColor } from "../appearance";
import type { BackpressureSignal, MotionSetting } from "../kit";
import { AnimationHost, backpressureFromTui, MotionPolicy } from "../kit";
import { resolveRenderTier } from "../terminal-capabilities";
import type { RemedyOptions, RemedyPlan } from "./remedy";
import { AuditTrailService, type AuditTrailServiceOptions } from "./service";
import type { AuditLedgerState, TouchObservation } from "./state";
import {
	type AuditPanelOptions,
	type AuditTrailBoxColors,
	type AuditTrailBoxTheme,
	AuditTrailBoxWidget,
	auditColors,
	renderAuditOffText,
	renderAuditPanel,
} from "./widget";

export { PROBE_INTERVAL_MS } from "./service";

const TERMINAL_PROGRAM = resolveRenderTier().program;

export const WIDGET_KEY = "audit-trail-box";
const DEFAULT_PLACEMENT: WidgetPlacement = "belowEditor";

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
	/** The host's live symbol preset (see `../glyph-presets.ts`). */
	glyphPreset: SymbolPreset;
	setWidget(key: string, content: ExtensionWidgetContent, options?: ExtensionWidgetOptions): void;
}

export interface AuditTrailBoxControllerOptions extends AuditTrailServiceOptions {
	placement?: WidgetPlacement;
	accentColor?: AccentColor;
}

type Mount = { mode: "animated"; host: AnimationHost; policy: MotionPolicy } | { mode: "static" };

/**
 * The host backpressure field is required before the widget factory supplies
 * the real `tui`; this adapter attaches the live signal inside that factory.
 */
function deferredBackpressure(): { signal: BackpressureSignal; attach(tui: object): void } {
	let attached: BackpressureSignal | undefined;
	return {
		signal: {
			get underPressure() {
				return attached?.underPressure ?? false;
			},
		},
		attach(tui: object) {
			attached = backpressureFromTui(tui);
		},
	};
}

/**
 * Optional standalone Audit Trail row. The nonvisual ledger/probe/remedy owner
 * is {@link AuditTrailService}; the canonical Audit Box observes the same
 * injected state and never receives a second copy of audit events.
 */
export class AuditTrailBoxController {
	#service: AuditTrailService;
	#mount: Mount | undefined;
	#widgetOptions: ExtensionWidgetOptions;
	#colors: AuditTrailBoxColors;
	#accentColor: AccentColor | undefined;
	#context: AuditTrailBoxContext | undefined;

	constructor(options: AuditTrailBoxControllerOptions = {}) {
		this.#widgetOptions = { placement: options.placement ?? DEFAULT_PLACEMENT };
		this.#accentColor = options.accentColor;
		this.#colors = auditColors(options.accentColor);
		const callerOnChange = options.onChange;
		this.#service = new AuditTrailService({
			...options,
			onChange: () => {
				callerOnChange?.();
				if (this.#context !== undefined) this.#refresh(this.#context);
			},
		});
	}

	get state(): AuditLedgerState {
		return this.#service.state;
	}

	async settled(): Promise<void> {
		await this.#service.settled();
	}

	noteRead(path: string, observed: TouchObservation, ctx: AuditTrailBoxContext): void {
		if (!this.#activate(ctx)) return;
		this.#service.noteRead(path, observed);
	}

	noteWrite(path: string, observed: TouchObservation, ctx: AuditTrailBoxContext): void {
		if (!this.#activate(ctx)) return;
		this.#service.noteWrite(path, observed);
	}

	noteTurn(ctx: AuditTrailBoxContext): void {
		if (!this.#activate(ctx)) return;
		this.#service.noteTurn();
	}

	noteRecovery(ctx: AuditTrailBoxContext): void {
		if (!this.#activate(ctx)) return;
		this.#service.noteRecovery();
	}

	noteSessionSwitch(ctx: AuditTrailBoxContext): void {
		if (!this.#activate(ctx)) return;
		this.#service.noteSessionSwitch();
	}

	async probeNow(ctx: AuditTrailBoxContext): Promise<void> {
		if (!this.#activate(ctx)) return;
		await this.#service.probeNow();
	}

	async remedy(ctx: AuditTrailBoxContext, options: RemedyOptions = {}): Promise<RemedyPlan> {
		if (ctx.hasUI) this.#context = ctx;
		return this.#service.remedy(options);
	}

	panel(ctx: AuditTrailBoxContext, options: AuditPanelOptions = {}): readonly string[] {
		return renderAuditPanel(this.state.snapshot(), ctx.theme, {
			colors: this.#colors,
			preset: ctx.glyphPreset,
			program: TERMINAL_PROGRAM,
			...options,
		});
	}

	dispose(ctx: Pick<AuditTrailBoxContext, "setWidget">): void {
		this.#context = undefined;
		this.#service.noteSessionSwitch();
		if (!this.#mount) return;
		if (this.#mount.mode === "animated") this.#mount.host.dispose();
		this.#mount = undefined;
		ctx.setWidget(WIDGET_KEY, undefined, this.#widgetOptions);
	}

	#activate(ctx: AuditTrailBoxContext): boolean {
		if (!ctx.hasUI) return false;
		this.#context = ctx;
		return true;
	}

	#refresh(ctx: AuditTrailBoxContext): void {
		if (!this.#mount) {
			this.#mount = this.#mountWidget(ctx);
		} else if (this.#mount.mode === "static") {
			ctx.setWidget(WIDGET_KEY, [renderAuditOffText(this.state.snapshot(), ctx.glyphPreset)], this.#widgetOptions);
		}
	}

	#mountWidget(ctx: AuditTrailBoxContext): Mount {
		const policy = new MotionPolicy({ hasUI: ctx.hasUI, isTTY: ctx.isTTY, env: ctx.env }, ctx.motionSetting);
		if (policy.tier === "off") {
			ctx.setWidget(WIDGET_KEY, [renderAuditOffText(this.state.snapshot(), ctx.glyphPreset)], this.#widgetOptions);
			return { mode: "static" };
		}

		const backpressure = deferredBackpressure();
		const host = new AnimationHost({ policy, backpressure: backpressure.signal, scheduler: this.#service.scheduler });
		const state = this.state;
		const clock = this.#service.scheduler;
		const glyphPreset = ctx.glyphPreset;
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
					glyphPreset,
				});
			},
			this.#widgetOptions,
		);
		return { mode: "animated", host, policy };
	}
}
