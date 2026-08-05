import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
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
}

export function createReflectionRippleExtension(options: ReflectionRippleExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new ReflectionRippleController();
		api.on("ttsr_triggered", (event, ctx) => {
			controller.onTtsrTriggered(event, toReflectionRippleContext(ctx, options));
		});
	};
}
