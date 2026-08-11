import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AccentColor } from "../appearance";
import type { MotionSetting } from "../kit";
import { type ReflectionRippleContext, ReflectionRippleController } from "./controller";

export * from "./controller";
export * from "./ripple";
export * from "./state";
export * from "./widget";

function readMotionSetting(options: ReflectionRippleExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toReflectionRippleContext(
	ctx: ExtensionContext,
	options: ReflectionRippleExtensionOptions,
): ReflectionRippleContext {
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
 * Reflection Ripple: each time TTSR interrupts generation to inject a
 * matched rule (`ttsr_triggered`), a calm concentric ripple expands outward
 * on an `aboveEditor` strip while the row briefly dims — the agent visibly
 * "taking a breath" before it reflects — then settles back to nothing once
 * the wave and the breath both recover. Built on the shared
 * `@oh-my-pi/pi-animation` kit: one `AnimationHost` per ripple, mounted
 * fresh on each trigger seen while unmounted, and torn all the way back down
 * (host disposed, widget removed) once it settles.
 */
export interface ReflectionRippleExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "aboveEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the ring); defaults to the built-in palette when unset. */
	accentColor?: AccentColor;
}

export function createReflectionRippleExtension(options: ReflectionRippleExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new ReflectionRippleController({
			placement: options.placement,
			accentColor: options.accentColor,
		});
		api.on("ttsr_triggered", (event, ctx) => {
			controller.onTtsrTriggered(event, toReflectionRippleContext(ctx, options));
		});
	};
}
