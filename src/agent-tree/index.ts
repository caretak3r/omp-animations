import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AccentColor } from "../appearance";
import type { FrameScheduler, MotionSetting } from "../kit";
import { type AgentRegistryLike, type AgentTreeContext, AgentTreeController } from "./controller";

export * from "./controller";
export * from "./state";
export * from "./widget";

function readMotionSetting(options: AgentTreeExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toAgentTreeContext(ctx: ExtensionContext, options: AgentTreeExtensionOptions): AgentTreeContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(options),
		theme: ctx.ui.theme,
		glyphPreset: ctx.ui.theme.getSymbolPreset(),
		setWidget: (key, content, widgetOptions) => ctx.ui.setWidget(key, content, widgetOptions),
	};
}

/** Options resolved by the shared animation registrar. */
export interface AgentTreeExtensionOptions {
	motionSetting?: MotionSetting;
	placement?: WidgetPlacement;
	accentColor?: AccentColor;
	/** Test seam; production resolves the process-global registry from `api.pi`. */
	registry?: AgentRegistryLike;
	/** Test seam for deterministic frame polling. */
	scheduler?: FrameScheduler;
}

/** Register the live subagent tree. The widget remains absent until a subagent exists. */
export function createAgentTreeExtension(options: AgentTreeExtensionOptions = {}): ExtensionFactory {
	return api => {
		const registry = options.registry ?? api.pi?.AgentRegistry?.global?.();
		if (registry === undefined) return;
		const controller = new AgentTreeController(registry, {
			scheduler: options.scheduler,
			placement: options.placement,
			accentColor: options.accentColor,
		});
		api.on("session_start", (_event, ctx) => controller.mount(toAgentTreeContext(ctx, options)));
		api.on("session_switch", (_event, ctx) => controller.onSessionSwitch(toAgentTreeContext(ctx, options)));
		api.on("session_shutdown", () => controller.dispose());
	};
}
