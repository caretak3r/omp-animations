import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { BOX_WIDGET_KEY } from "../src/animations-box/controller";
import { DEFAULT_FRAME_SCHEDULER } from "../src/kit";
import { createAnimationsPlugin } from "../src/registrar";

/**
 * Boot smoke through the production registrar. The session mounts one complete
 * widget on one host, starts one scheduler when it subscribes, and tears the
 * shared host down on shutdown.
 *
 * `createAnimationsPlugin`/`createAuditTrailBoxExtension` accept no injectable
 * scheduler (the registrar always uses `DEFAULT_FRAME_SCHEDULER`, real
 * `setInterval`/`clearInterval`), so the leak assertion wraps the shared
 * `DEFAULT_FRAME_SCHEDULER.start` to count *live* timers — incremented on
 * every real `start()`, decremented when its returned stop function actually
 * runs. `AnimationHost` only calls `start()` when a subscriber attaches and
 * only calls its stop function once the subscriber count drops back to zero
 * (`src/kit/animation-host.ts#sync`), so this live-timer count is exactly the
 * same "leaked subscription or timer" proxy `test/breathing-border.test.ts`'s
 * own controller-level leak tests use (there, a manual `FrameScheduler`'s own
 * `running` boolean) — real timers stand in for the manual scheduler that
 * isn't reachable through the registrar seam.
 */

/** A minimal `session_start` — the single event the Audit Box needs to mount. */
function sessionStart(): unknown {
	return { type: "session_start" };
}

/** Recording `ExtensionAPI` double that actually stores handlers (not just event names) so they can be fired. */
function makeApi(): {
	api: ExtensionAPI;
	fire(event: string, payload: unknown, ctx: ExtensionContext): void;
} {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setLabel: () => {},
		registerCommand: () => {},
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

/** A minimal but complete `ExtensionContext`: only the fields Audit Trail Box's `toAuditContext` reads. */
function makeCtx(): { ctx: ExtensionContext; widgetCalls: Array<{ key: string; content: unknown }> } {
	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: { ...idTheme, getSymbolPreset: () => "unicode" as const },
			setWidget: (key: string, content: unknown) => {
				widgetCalls.push({ key, content });
			},
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;
	return { ctx, widgetCalls };
}

/** A minimal `write` `tool_result` — the single event Audit Trail Box needs to mount. */
function writeToolResult(): unknown {
	return {
		type: "tool_result",
		toolName: "write",
		toolCallId: "call-1",
		input: { path: "/tmp/boot-smoke-audit-trail-box.ts", content: "export const x = 1;" },
		content: [{ type: "text", text: "ok" }],
		isError: false,
	};
}

describe("boot smoke (loads the plugin, mounts a widget, disposes it)", () => {
	let liveTimers = 0;
	let startSpy: ReturnType<typeof spyOn>;
	let originalIsTTY: boolean | undefined;
	let originalEnv: Record<string, string | undefined> = {};

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
		// *real* `process.stdout.isTTY` and the *real* `Bun.env` (never the test's fake
		// `ExtensionContext`) — see e.g. `src/audit-trail-box/index.ts#toAuditContext`.
		// Bun's test runner has no TTY attached, and NO_COLOR / CI / TERM=dumb in the
		// invoking shell each force the `off` tier, so without this the animated-mount
		// assertions below would be checking the shell we ran under, not the code.
		originalIsTTY = process.stdout.isTTY;
		process.stdout.isTTY = true;
		originalEnv = { NO_COLOR: Bun.env.NO_COLOR, CI: Bun.env.CI, TERM: Bun.env.TERM };
		delete Bun.env.NO_COLOR;
		delete Bun.env.CI;
		Bun.env.TERM = "xterm-256color";
	});

	afterEach(() => {
		process.stdout.isTTY = originalIsTTY as boolean;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		startSpy.mockRestore();
		// Guard against a genuinely leaked real timer failing silently: if the count
		// never made it back to zero, something in this test (or the code under test)
		// really did leak — surface it loudly rather than letting the interval run on
		// into whatever test file executes next.
		expect(liveTimers).toBe(0);
	});

	it("mounts one complete widget and leaves zero subscriptions or timers after shutdown", () => {
		const { api, fire } = makeApi();
		createAnimationsPlugin({ settings: {}, env: {} })(api);

		const { ctx, widgetCalls } = makeCtx();

		expect(liveTimers).toBe(0);
		fire("session_start", sessionStart(), ctx);

		// The controller hands the UI one widget factory. No timer exists until
		// the real TUI invokes it.
		expect(widgetCalls).toHaveLength(1);
		expect(widgetCalls.map(call => call.key)).toEqual([BOX_WIDGET_KEY]);
		expect(liveTimers).toBe(0);

		const widgets = widgetCalls.map(call => {
			const factory = call.content as (
				tui: typeof noopTui,
				theme: typeof idTheme,
			) => { render(width: number): readonly string[]; dispose(): void };
			return factory(noopTui, idTheme);
		});

		// The complete widget subscribes to the host and starts one timer.
		expect(liveTimers).toBe(1);

		fire("tool_result", writeToolResult(), ctx);
		expect(widgets[0]?.render(72).length).toBeGreaterThan(0);
		expect(widgets[0]?.render(72)[0]?.length).toBeGreaterThan(0);

		fire("session_shutdown", { type: "session_shutdown" }, ctx);

		expect(liveTimers).toBe(0);
		expect(widgetCalls.slice(-1).every(call => call.content === undefined)).toBe(true);
	});

	it("no UI surface: the box never mounts, so nothing leaks", () => {
		const { api, fire } = makeApi();
		createAnimationsPlugin({ settings: {}, env: {} })(api);

		const { ctx, widgetCalls } = makeCtx();
		const headless = { ...ctx, hasUI: false } as ExtensionContext;
		fire("session_start", sessionStart(), headless);
		fire("tool_result", writeToolResult(), headless);
		fire("session_shutdown", { type: "session_shutdown" }, headless);

		expect(widgetCalls).toEqual([]);
		expect(liveTimers).toBe(0);
	});
});
