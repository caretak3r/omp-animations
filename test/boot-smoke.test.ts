import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { DEFAULT_FRAME_SCHEDULER } from "../src/kit";
import { ANIMATIONS, createAnimationsPlugin } from "../src/registrar";

/**
 * Boot smoke: end-to-end through the real production entrypoint
 * (`createAnimationsPlugin`, `src/registrar.ts`) rather than a controller
 * constructed directly. `test/registrar.test.ts` already covers wire-time
 * enablement (which `api.on(...)` calls happen), but never actually fires an
 * event or constructs a widget — this file extends that pattern one step
 * further: fire the real lifecycle events, obtain the real widget factory the
 * controller hands the UI, construct the real widget, and prove the whole
 * chain leaves nothing running after teardown.
 *
 * Prompt Charge is the concrete widget under test: of the 13 registrar-mounted
 * animations it is the only one whose full mount->dispose loop is reachable
 * through `ExtensionAPI` alone (`session_start` mounts unconditionally,
 * `session_shutdown` disposes — see `src/prompt-charge/index.ts`) — no
 * process-global registry (Agent Fleet) or event fixtures beyond what a
 * session boot already provides. The pattern generalizes to any other
 * registrar-mounted animation with a `session_start`/`session_shutdown` (or
 * equivalent) mount/dispose pair.
 *
 * `createAnimationsPlugin`/`createPromptChargeExtension` accept no injectable
 * scheduler (the registrar always uses `DEFAULT_FRAME_SCHEDULER`, real
 * `setInterval`/`clearInterval`), so the leak assertion wraps the shared
 * `DEFAULT_FRAME_SCHEDULER.start` to count *live* timers — incremented on
 * every real `start()`, decremented when its returned stop function actually
 * runs. `AnimationHost` only calls `start()` when a subscriber attaches and
 * only calls its stop function once the subscriber count drops back to zero
 * (`src/kit/animation-host.ts#sync`), so this live-timer count is exactly the
 * same "leaked subscription or timer" proxy `test/goal-horizon.test.ts`'s own
 * controller-level leak test uses (there, an injected fake scheduler's
 * `running` boolean) — real timers stand in for the fake scheduler that isn't
 * reachable through the registrar seam.
 */

const noopRead = async (): Promise<Record<string, unknown>> => ({});

/** A flat enable record with exactly one animation on — mirrors `registrar.test.ts`'s `only`. */
function only(id: string): Record<string, boolean> {
	return Object.fromEntries(ANIMATIONS.map(a => [a.id, a.id === id]));
}

/** Recording `ExtensionAPI` double that actually stores handlers (not just event names) so they can be fired. */
function makeApi(): {
	api: ExtensionAPI;
	fire<E extends { type: string }>(event: E["type"], payload: E, ctx: ExtensionContext): void;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setLabel: () => {},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;
	return {
		api,
		fire(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

const idTheme = { fg: (_color: string, text: string) => text };
const noopTui = { requestComponentRender: () => {} };

/** A minimal but complete `ExtensionContext`: only the fields Prompt Charge's `toPromptChargeContext` reads. */
function makeCtx(): { ctx: ExtensionContext; widgetCalls: Array<{ key: string; content: unknown }> } {
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const ctx = {
		hasUI: true,
		ui: {
			theme: idTheme,
			getEditorText: () => "",
			setWidget: (key: string, content: unknown) => {
				widgetCalls.push({ key, content });
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, widgetCalls };
}

describe("boot smoke (loads the plugin, mounts a widget, disposes it)", () => {
	let liveTimers = 0;
	let startSpy: ReturnType<typeof spyOn>;
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		liveTimers = 0;
		const realStart = DEFAULT_FRAME_SCHEDULER.start;
		startSpy = spyOn(DEFAULT_FRAME_SCHEDULER, "start").mockImplementation((intervalMs: number, tick: () => void) => {
			liveTimers++;
			const stop = realStart(intervalMs, tick);
			return () => {
				liveTimers--;
				stop();
			};
		});
		// Every registrar-mounted animation's context adapter hard-gates motion on the
		// *real* `process.stdout.isTTY` (never the test's fake `ExtensionContext`) — see
		// e.g. `src/prompt-charge/index.ts#toPromptChargeContext`. Bun's test runner has
		// no TTY attached, so without this the plugin always resolves the `off` tier and
		// the animated-mount assertions below would be checking nothing.
		originalIsTTY = process.stdout.isTTY;
		process.stdout.isTTY = true;
	});

	afterEach(() => {
		process.stdout.isTTY = originalIsTTY as boolean;
		startSpy.mockRestore();
		// Guard against a genuinely leaked real timer failing silently: if the count
		// never made it back to zero, something in this test (or the code under test)
		// really did leak — surface it loudly rather than letting the interval run on
		// into whatever test file executes next.
		expect(liveTimers).toBe(0);
	});

	it("real registrar wiring: session_start mounts, dispose leaves zero live subscriptions/timers", () => {
		const { api, fire } = makeApi();
		createAnimationsPlugin({ settings: only("promptCharge"), env: {}, readPluginSettings: noopRead })(api);

		const { ctx, widgetCalls } = makeCtx();

		expect(liveTimers).toBe(0);
		fire("session_start", { type: "session_start" }, ctx);

		// The controller hands the UI a widget *factory*, not a live widget — no
		// timer exists until the (real) TUI actually invokes it, same as production.
		expect(widgetCalls).toHaveLength(1);
		expect(widgetCalls[0].key).toBe("prompt-charge");
		expect(liveTimers).toBe(0);

		const factory = widgetCalls[0].content as (
			tui: typeof noopTui,
			theme: typeof idTheme,
		) => { render(width: number): readonly string[]; dispose(): void };
		const widget = factory(noopTui, idTheme);

		// Constructing the widget subscribes it to the shared AnimationHost: exactly
		// one live subscription/timer for this one mount.
		expect(liveTimers).toBe(1);

		// It is a genuinely live, rendering widget, not a stub.
		const rows = widget.render(30);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.length).toBeGreaterThan(0);

		fire("session_shutdown", { type: "session_shutdown" }, ctx);

		// The controller's dispose() tears the host all the way down: zero live
		// timers survive, and the UI was told to clear the widget.
		expect(liveTimers).toBe(0);
		expect(widgetCalls.at(-1)?.content).toBeUndefined();
	});

	it("a disabled animation's factory is never invoked — mounting nothing leaks nothing", () => {
		const { api, fire } = makeApi();
		createAnimationsPlugin({ settings: only("__none__"), env: {}, readPluginSettings: noopRead })(api);

		const { ctx, widgetCalls } = makeCtx();
		fire("session_start", { type: "session_start" }, ctx);
		fire("session_shutdown", { type: "session_shutdown" }, ctx);

		expect(widgetCalls).toEqual([]);
		expect(liveTimers).toBe(0);
	});
});
