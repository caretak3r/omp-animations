import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { MotionSetting } from "../kit";
import { type CadenceEqualizerContext, CadenceEqualizerController } from "./controller";

export * from "./bars";
export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(options: CadenceEqualizerExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toCadenceEqualizerContext(
	ctx: ExtensionContext,
	options: CadenceEqualizerExtensionOptions,
): CadenceEqualizerContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(options),
		theme: ctx.ui.theme,
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Cadence Equalizer: a multi-band VU-style meter for live token throughput,
 * grounded on the same `tokensPerSecond` provider (`token-rate.ts`) as
 * Token Tide. A `belowEditor` widget where {@link BAND_COUNT} bands each
 * track the identical signal through a differently-tuned exponential
 * moving average — a fast band that jitters with every burst, a slow band
 * that lags and smooths — so the bars visibly dance relative to each other
 * rather than moving in lockstep as one filled bar would. Each band also
 * keeps a peak-hold marker (a classic hardware VU-meter cue absent from
 * Token Tide) that snaps up on a new high and decays slowly, leaving a
 * faint cap over a band that's coasting down from a recent spike.
 */
export interface CadenceEqualizerExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "belowEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the burst bucket); defaults to the built-in palette when unset. */
	accentColor?: ThemeColor;
}

export function createCadenceEqualizerExtension(options: CadenceEqualizerExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new CadenceEqualizerController({
			placement: options.placement,
			accentColor: options.accentColor,
		});
		api.on("message_start", (event, ctx) => {
			controller.onMessageStart(event, toCadenceEqualizerContext(ctx, options));
		});
		api.on("message_update", (event, ctx) => {
			controller.onMessageUpdate(event, toCadenceEqualizerContext(ctx, options));
		});
		api.on("message_end", (event, ctx) => {
			controller.onMessageEnd(event, toCadenceEqualizerContext(ctx, options));
		});
	};
}
