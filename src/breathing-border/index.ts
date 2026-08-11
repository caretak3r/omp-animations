import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AccentColor } from "../appearance";
import type { MotionSetting } from "../kit";
import { type BreathingBorderContext, BreathingBorderController } from "./controller";

export * from "./breath";
export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(options: BreathingBorderExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toBreathingBorderContext(
	ctx: ExtensionContext,
	options: BreathingBorderExtensionOptions,
): BreathingBorderContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(options),
		theme: ctx.ui.theme,
		glyphPreset: ctx.ui.theme.getSymbolPreset(),
		setWidget: (key, content, options) => ctx.ui.setWidget(key, content, options),
	};
}

/**
 * Breathing Border: while the agent works, a faint luminance pulse breathes
 * along an `aboveEditor` border strip on a ~4s inhale/exhale — ambient
 * presence, felt not seen. On `agent_end` it winds down in one slow exhale
 * then goes perfectly still. `turn_start`/`turn_end` modulate the breath
 * cadence from the just-finished turn's duration. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` for the whole session,
 * mounted on the first `agent_start` seen, and torn back down to a static
 * widget once the post-`agent_end` exhale settles — this is the reference
 * demo for the kit's off/subtle/full motion ladder and its backpressure gate.
 */
export interface BreathingBorderExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "aboveEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the peak brightness); defaults to the built-in palette when unset. */
	accentColor?: AccentColor;
}

export function createBreathingBorderExtension(options: BreathingBorderExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new BreathingBorderController({
			placement: options.placement,
			accentColor: options.accentColor,
		});
		api.on("agent_start", (event, ctx) => {
			controller.onAgentStart(event, toBreathingBorderContext(ctx, options));
		});
		api.on("agent_end", (event, ctx) => {
			controller.onAgentEnd(event, toBreathingBorderContext(ctx, options));
		});
		api.on("turn_start", (event, ctx) => {
			controller.onTurnStart(event, toBreathingBorderContext(ctx, options));
		});
		api.on("turn_end", (event, ctx) => {
			controller.onTurnEnd(event, toBreathingBorderContext(ctx, options));
		});
	};
}
