import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { AccentColor } from "../appearance";
import type { MotionSetting } from "../kit";
import { type PalimpsestContext, PalimpsestController } from "./controller";

export * from "./controller";
export * from "./spans";
export * from "./state";
export * from "./widget";

function readMotionSetting(options: PalimpsestExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toPalimpsestContext(ctx: ExtensionContext, options: PalimpsestExtensionOptions): PalimpsestContext {
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
 * Palimpsest: a thrash detector. It keeps a per-file ledger of edited line
 * spans (`EditToolDetails.diff`'s hunk headers, parsed with zero file I/O)
 * and glows only the regions the agent keeps re-editing — a faint underline
 * at 2 touches, amber at 3, a slow ember pulse at 4+ — surfacing the "going
 * in circles" failure mode that otherwise has no ambient signal at all.
 * Invisible during healthy forward progress: no repeated touch, no row.
 * Built on the shared `@oh-my-pi/pi-animation` kit: an `AnimationHost` mounts
 * only once some region actually crosses the glow threshold, and tears back
 * down the moment nothing in the ledger is visible any more (a region can
 * fade out `turn_end` by `turn_end` even with no further edits).
 */
export interface PalimpsestExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "belowEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the ember tier); defaults to the built-in palette when unset. */
	accentColor?: AccentColor;
}

export function createPalimpsestExtension(options: PalimpsestExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new PalimpsestController({ placement: options.placement, accentColor: options.accentColor });
		api.on("tool_result", (event, ctx) => {
			controller.onToolResult(event, toPalimpsestContext(ctx, options));
		});
		api.on("turn_end", (event, ctx) => {
			controller.onTurnEnd(event, toPalimpsestContext(ctx, options));
		});
	};
}
