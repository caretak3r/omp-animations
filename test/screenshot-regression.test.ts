import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { BOX_WIDGET_KEY, SIGNAL_WIDGET_KEY } from "../src/animations-box/controller";
import { BOX_OPTIONAL_SEGMENT_IDS, BOX_REQUIRED_SEGMENT_IDS } from "../src/animations-box/settings";
import { createAnimationsPlugin } from "../src/registrar";

/**
 * End-to-end renderer regression for the duplicate-heavy launch configuration
 * that produced the "before" screenshot: every animation enabled, the removed
 * `display: "both"` still in the settings file, detailed box. That value used
 * to mount a standalone widget per animation *and* the box, so every metric was
 * drawn twice.
 *
 * Everything here goes through the real production entrypoint
 * (`createAnimationsPlugin`, `src/registrar.ts`) and the real `api.on(...)`
 * handlers the host calls — no directly constructed controller, no hand-rolled
 * `SegmentSample`. `test/animations-box-goldens.test.ts` pins exact frame text
 * from the controller seam; this file is its end-to-end complement, asserting
 * the structural contract of that one configuration at the same three widths.
 */

/** The settings file behind the "before" screenshot, stale keys and all. */
const SCREENSHOT_SETTINGS: Record<string, unknown> = {
	// Removed: normalizes to the box with one migration warning, never throws.
	display: "both",
	animationsBoxDetail: "detailed",
	breathingBorder: true,
	cacheMeter: true,
	auditTrailBox: true,
	rateLimitTidepool: true,
	liveFiles: true,
	cadenceEqualizer: true,
	reflectionRipple: true,
	agentBonsai: true,
	// Deleted animation and the pre-rename Agent Tree key: both inert.
	toolConstellation: true,
	agentTree: true,
};

const WIDTHS = [45, 69, 120] as const;

/**
 * The host context reading behind the scene: a 200K window at 120K used — 60%
 * of the window, 75% of the default 80% quota. Real enough that the top row
 * carries its whole span ladder instead of the resting dash.
 */
const SCREENSHOT_USAGE = { tokens: 120_000, contextWindow: 200_000, percent: 60 };

const idTheme = { fg: (_color: string, text: string) => text };
const noopTui = { requestComponentRender: () => {} };

interface Launch {
	widget: { render(width: number): readonly string[] };
	widgetKeys: string[];
	lastWidgetContent: unknown;
	warnings: string[];
	commands: string[];
	fire(event: string, payload: unknown): void;
}

/**
 * Wire the plugin, fire `session_start`, and build the widget the controller
 * handed the UI — the same factory-then-construct sequence the real TUI runs.
 * `withContextUsage: false` models a host that never exposes
 * `getContextUsage`, which the registrar has to survive.
 */
function launch(settings: Record<string, unknown>, withContextUsage = true): Launch {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => void>>();
	const commands: string[] = [];
	const warnings: string[] = [];
	const api = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		setLabel: () => {},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		logger: {
			error() {},
			warn(message: string) {
				warnings.push(message);
			},
			debug() {},
			info() {},
		},
	} as unknown as ExtensionAPI;

	const widgetCalls: Array<{ key: string; content: unknown }> = [];
	const ctx = {
		hasUI: true,
		cwd: "/repo",
		getContextUsage: withContextUsage ? () => SCREENSHOT_USAGE : undefined,
		ui: {
			theme: { ...idTheme, getSymbolPreset: () => "unicode" as const },
			setWidget: (key: string, content: unknown) => {
				widgetCalls.push({ key, content });
			},
			setStatus: () => {},
		},
	} as unknown as ExtensionContext;

	createAnimationsPlugin({ settings, env: {}, cwd: "/repo" })(api);
	const fire = (event: string, payload: unknown): void => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	fire("session_start", { type: "session_start" });

	const factory = widgetCalls[0]?.content as (
		tui: unknown,
		theme: unknown,
	) => { render(w: number): readonly string[] };
	return {
		widget: factory(noopTui, idTheme),
		get widgetKeys() {
			return widgetCalls.map(call => call.key);
		},
		get lastWidgetContent() {
			return widgetCalls.at(-1)?.content;
		},
		warnings,
		commands,
		fire,
	};
}

function assistantMessage(output: number, duration: number): unknown {
	return {
		type: "message_start",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output },
			timestamp: 0,
			duration,
		},
	};
}

/** The event choreography behind the screenshot: one cached turn, a file read+write, rate-limit headers, three tool calls. */
function driveScreenshotScene(session: Launch): void {
	session.fire("message_end", {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: { input: 400, output: 10, cacheRead: 600, cacheWrite: 200, totalTokens: 1210 },
			stopReason: "stop",
			timestamp: 0,
		},
	});
	session.fire("message_start", assistantMessage(100, 1000));
	session.fire("tool_result", {
		type: "tool_result",
		toolCallId: "tc-read",
		toolName: "read",
		input: { path: "/repo/src/widget.ts" },
		content: [],
		isError: false,
		details: { resolvedPath: "/repo/src/widget.ts" },
	});
	session.fire("tool_result", {
		type: "tool_result",
		toolCallId: "tc-write",
		toolName: "write",
		input: { path: "/repo/src/widget.ts", content: "hello" },
		content: [],
		isError: false,
	});
	session.fire("after_provider_response", {
		type: "after_provider_response",
		headers: {
			"anthropic-ratelimit-requests-limit": "100",
			"anthropic-ratelimit-requests-remaining": "78",
			// What a provider actually sends: an absolute RFC3339 instant on the
			// real wall clock, ~12m out.
			"anthropic-ratelimit-requests-reset": new Date(Date.now() + 725_000).toISOString(),
		},
	});
	// A second assistant message reveals the provider behind the pending headers.
	session.fire("message_start", assistantMessage(50, 500));
	session.fire("tool_call", { type: "tool_call", toolCallId: "tc-1", toolName: "write", input: {} });
	session.fire("tool_call", { type: "tool_call", toolCallId: "tc-2", toolName: "read", input: {} });
	session.fire("tool_call", { type: "tool_call", toolCallId: "tc-3", toolName: "bash", input: {} });
}

/** Content between the side borders, trailing pad removed. Border rows come back unchanged. */
function innerText(row: string): string {
	return row.startsWith("│") ? row.slice(1, -1).trimEnd() : row;
}

/** `cache` / `audit` / … for a segment row, `""` for the blank separator and the borders. */
function rowLabel(row: string): string {
	if (!row.startsWith("│")) return "";
	return innerText(row).trim().split(/\s+/)[1] ?? "";
}

function labels(rows: readonly string[]): string[] {
	return rows.map(rowLabel);
}

describe("screenshot regression — the duplicate-heavy launch configuration renders one box", () => {
	it("one required block, one separator, only enabled optional animations", () => {
		const session = launch(SCREENSHOT_SETTINGS);
		driveScreenshotScene(session);
		const rows = session.widget.render(69);

		// Borders, then the six Audit summaries in registry order. Live Files
		// closes the block, followed by one blank separator and the two optional
		// groups that draw a row.
		expect(labels(rows)).toEqual([
			"",
			"context",
			"cache",
			"audit",
			"limits",
			"tools",
			"files",
			"",
			"cadence",
			"reflect",
			"",
		]);
		expect(rows.filter(row => innerText(row) === "" && row.startsWith("│"))).toHaveLength(1);
		expect(rows.slice(1, 1 + BOX_REQUIRED_SEGMENT_IDS.length).every(row => innerText(row) !== "")).toBe(true);

		// The scene activates context, cache, audit, limits, tools, and cadence.
		// Live Files closes the required block at rest.
		expect(innerText(rows[1])).toContain("75% quota");
		expect(innerText(rows[2])).toContain("50% hit");
		expect(innerText(rows[3])).toContain("1 read · 1 write");
		expect(innerText(rows[4])).toContain("78% left");
		expect(innerText(rows[5])).toContain("3 calls");
		expect(innerText(rows[6])).toContain("—");
		expect(innerText(rows[8])).toContain("t/s");
	});

	it("a host that never exposes getContextUsage still draws the gauge row, at rest", () => {
		const blind = launch(SCREENSHOT_SETTINGS, false);
		const seeing = launch(SCREENSHOT_SETTINGS);
		driveScreenshotScene(blind);
		driveScreenshotScene(seeing);
		const blindRows = blind.widget.render(69);

		// The reading is optional host surface. Without it, the context row rests
		// on its placeholder. Every other row stays unchanged.
		const seeingRows = seeing.widget.render(69);
		expect(labels(blindRows)).toEqual(labels(seeingRows));
		expect(innerText(blindRows[1])).toContain("—");
		expect(innerText(blindRows[1])).not.toContain("quota");
		expect(blindRows[1]).not.toBe(seeingRows[1]);
		expect(blindRows.slice(2)).toEqual(seeingRows.slice(2));
	});

	it("an absolute provider reset header renders a wall-clock ETA", () => {
		const session = launch(SCREENSHOT_SETTINGS);
		driveScreenshotScene(session);
		const limits = innerText(session.widget.render(69).find(row => rowLabel(row) === "limits") as string);

		// The header above is `Date.now() + 725s`. The box's frame clock and the
		// ingested `resetAtMs` must share one time base, or the ETA comes out
		// epoch-sized (`resets 29779368m`) on every real session.
		const eta = /resets (\d+)m/.exec(limits);
		expect(eta).not.toBeNull();
		expect(Number((eta as RegExpExecArray)[1])).toBeLessThanOrEqual(12);
		expect(Number((eta as RegExpExecArray)[1])).toBeGreaterThanOrEqual(11);
	});

	it("the removed `display` value warns once and changes nothing that renders", () => {
		const withDisplay = launch(SCREENSHOT_SETTINGS);
		const { display: _removed, ...withoutDisplay } = SCREENSHOT_SETTINGS;
		const clean = launch(withoutDisplay);
		driveScreenshotScene(withDisplay);
		driveScreenshotScene(clean);

		expect(withDisplay.warnings).toHaveLength(1);
		expect(withDisplay.warnings[0]).toContain('"display"=both is no longer supported');
		expect(clean.warnings).toEqual([]);
		for (const width of WIDTHS) {
			expect(withDisplay.widget.render(width)).toEqual(clean.widget.render(width));
		}
	});

	it("right tails shed from the right and stay adjacent at 45, 69 and 120", () => {
		const session = launch(SCREENSHOT_SETTINGS);
		driveScreenshotScene(session);
		const frames = WIDTHS.map(width => session.widget.render(width));

		for (const [index, width] of WIDTHS.entries()) {
			for (const row of frames[index]) expect(visibleWidth(row)).toBe(width);
		}

		// Narrow frames are the wide frame with tail entries dropped off the
		// right — never re-flowed, never right-flushed, never a hole in between.
		const [narrow, real, wide] = frames;
		expect(narrow).toHaveLength(real.length);
		expect(real).toHaveLength(wide.length);
		for (let row = 0; row < real.length; row++) {
			if (!real[row].startsWith("│")) continue; // the two border rows scale with the frame
			expect(innerText(wide[row]).startsWith(innerText(real[row]))).toBe(true);
			expect(innerText(real[row]).startsWith(innerText(narrow[row]))).toBe(true);
		}

		// The ladder is not vacuous: the metric rows shed tail entries.
		expect(innerText(real[1]).length).toBeGreaterThan(innerText(narrow[1]).length);
		expect(innerText(real[2]).length).toBeGreaterThan(innerText(narrow[2]).length);
		expect(innerText(real[3]).length).toBeGreaterThan(innerText(narrow[3]).length);
		expect(innerText(real[4]).length).toBeGreaterThan(innerText(narrow[4]).length);
	});

	it("disabling every optional group leaves the required block with no separator", () => {
		const session = launch({
			...SCREENSHOT_SETTINGS,
			...Object.fromEntries(BOX_OPTIONAL_SEGMENT_IDS.map(id => [id, false])),
		});
		driveScreenshotScene(session);
		const rows = session.widget.render(69);

		expect(labels(rows)).toEqual(["", "context", "cache", "audit", "limits", "tools", "files", ""]);
		expect(rows.filter(row => innerText(row) === "" && row.startsWith("│"))).toEqual([]);
	});

	it("each optional group is gated by its own key", () => {
		const cadenceOnly = launch({ ...SCREENSHOT_SETTINGS, reflectionRipple: false, agentBonsai: false });
		const reflectOnly = launch({ ...SCREENSHOT_SETTINGS, cadenceEqualizer: false, agentBonsai: false });
		driveScreenshotScene(cadenceOnly);
		driveScreenshotScene(reflectOnly);

		expect(labels(cadenceOnly.widget.render(69)).slice(8, -1)).toEqual(["cadence"]);
		expect(labels(reflectOnly.widget.render(69)).slice(8, -1)).toEqual(["reflect"]);
	});

	it("mounts two widget keys on one controller and clears both on shutdown", () => {
		const session = launch(SCREENSHOT_SETTINGS);
		driveScreenshotScene(session);
		// A second session_start must not mount another surface.
		session.fire("session_start", { type: "session_start" });
		session.fire("session_shutdown", { type: "session_shutdown" });

		expect(new Set(session.widgetKeys)).toEqual(new Set([BOX_WIDGET_KEY, SIGNAL_WIDGET_KEY]));
		expect(session.widgetKeys).toHaveLength(4); // two mounts, then two shutdown clears
		expect(session.lastWidgetContent).toBeUndefined();
		expect(session.commands).toEqual(["audit-trail", "cache"]);
	});
});
