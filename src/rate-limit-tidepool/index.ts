import type {
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { MotionSetting } from "../kit";
import { RateLimitTidepoolController, type TidepoolContext } from "./controller";

export * from "./controller";
export * from "./state";
export * from "./tidepool";
export * from "./widget";

function readMotionSetting(options: RateLimitTidepoolExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toTidepoolContext(ctx: ExtensionContext, options: RateLimitTidepoolExtensionOptions): TidepoolContext {
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

/**
 * Rate-Limit Tidepool: a `belowEditor` gauge reading how much rate-limit
 * headroom the last response reported. Whitelists exactly two header
 * families — Anthropic's `anthropic-ratelimit-{resource}-{field}` (absolute
 * RFC3339 reset) and OpenAI's `x-ratelimit-{field}-{resource}` (Go-style
 * duration reset), keyed on `AssistantMessage.provider` — and stays invisible
 * for every other gateway (see `tidepool.ts`'s module doc). A full pool reads
 * as calm; receding headroom exposes pebbles, then wet sand near-empty; the
 * response's own `*-reset` header drives a slow refill back toward full
 * between requests. Built on the shared `@oh-my-pi/pi-animation` kit: one
 * `AnimationHost` per session, mounted fresh on the first recognized
 * response and never torn back down for the rest of the session — see
 * `controller.ts`'s module doc for why this needs no request/response
 * pairing at all.
 */
export interface RateLimitTidepoolExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "belowEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the water); defaults to the built-in palette when unset. */
	accentColor?: ThemeColor;
}

export function createRateLimitTidepoolExtension(options: RateLimitTidepoolExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new RateLimitTidepoolController({
			placement: options.placement,
			accentColor: options.accentColor,
		});

		api.on("after_provider_response", (event, ctx) =>
			controller.onAfterProviderResponse(event, toTidepoolContext(ctx, options)),
		);
		api.on("message_start", (event, ctx) => controller.onMessageStart(event, toTidepoolContext(ctx, options)));
		api.on("session_switch", (_event, ctx) => controller.dispose(toTidepoolContext(ctx, options)));
		api.on("session_shutdown", (_event, ctx) => controller.dispose(toTidepoolContext(ctx, options)));
	};
}
