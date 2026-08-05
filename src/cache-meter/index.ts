import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { MotionSetting } from "../kit";
import { type CacheMeterContext, CacheMeterController } from "./controller";

export * from "./controller";
export * from "./state";
export * from "./widget";

/** The slash command this extension registers. */
export const CACHE_METER_COMMAND = "cache";

function readMotionSetting(options: CacheMeterExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toCacheMeterContext(ctx: ExtensionContext, options: CacheMeterExtensionOptions): CacheMeterContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(options),
		theme: ctx.ui.theme,
		setWidget: (key, content, widgetOptions) => ctx.ui.setWidget(key, content, widgetOptions),
	};
}

/**
 * Cache Meter: a session-scoped LLM prompt-cache ledger. The ambient surface
 * is a compact `aboveEditor` widget showing how much of each finalized
 * request was served from the provider's cache versus re-paid for, aggregated
 * over the whole session; `/cache` prints the full breakdown, grouped by
 * provider and model, with totals, the dollar cost/savings behind those
 * tokens (`Usage.cost`, see `state.ts`), and the count of detected cache
 * invalidations — each credited, when possible, to the compaction,
 * auto-compaction, session switch, or model switch that most recently
 * preceded it.
 *
 * Invalidation detection ports the semantics of the host's own
 * `detectCacheInvalidation` (`modes/components/cache-invalidation-marker.ts`,
 * see `state.ts`'s `detectCacheInvalidation` for the full port and citation):
 * only an explicit, prefix-controlled cache (Anthropic/Bedrock, which reports
 * `cacheWrite > 0` on a cold turn) can be said to have "lost" a warm prefix.
 * Implicit-cache providers (Google/OpenAI/Fireworks) report `cacheWrite: 0`
 * and drop `cacheRead` to zero intermittently as routine propagation noise,
 * so they never trigger a false alarm here. That marker module pulls in the
 * theme singleton at module load — a value import that throws on
 * darwin-arm64 without a built native `.node` for this platform (the same
 * blocker every controller/widget in this package works around by staying on
 * `import type` for `@oh-my-pi/pi-coding-agent` internals) — so the logic is
 * reimplemented as a pure local function rather than imported.
 */
export interface CacheMeterExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "aboveEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the badge); defaults to the built-in palette when unset. */
	accentColor?: ThemeColor;
}

export function createCacheMeterExtension(options: CacheMeterExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new CacheMeterController({ placement: options.placement, accentColor: options.accentColor });

		api.on("message_end", (event, ctx) => controller.onMessageEnd(event, toCacheMeterContext(ctx, options)));
		api.on("session_compact", (_event, ctx) => controller.onSessionCompact(toCacheMeterContext(ctx, options)));
		api.on("auto_compaction_start", (event, ctx) =>
			controller.onAutoCompactionStart(event, toCacheMeterContext(ctx, options)),
		);
		// session_switch resets the whole ledger via dispose() rather than attributing through
		// onSessionSwitch — see that method's doc comment for why reset wins.
		api.on("session_switch", (_event, ctx) => controller.dispose(toCacheMeterContext(ctx, options)));
		api.on("session_shutdown", (_event, ctx) => controller.dispose(toCacheMeterContext(ctx, options)));

		api.registerCommand(CACHE_METER_COMMAND, {
			description:
				"Session prompt-cache breakdown: per-provider/model reads, writes, misses, hit rate, invalidations",
			handler: async (_args, ctx: ExtensionCommandContext) => {
				if (!ctx.hasUI) return;
				ctx.ui.notify(controller.panel(toCacheMeterContext(ctx, options)).join("\n"), "info");
			},
		});
	};
}
