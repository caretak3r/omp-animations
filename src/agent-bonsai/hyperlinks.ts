import { TERMINAL } from "@oh-my-pi/pi-tui";

/**
 * Plugin-local OSC 8 hyperlink emission.
 *
 * The host ships `uriHyperlink`/`isHyperlinkEnabled` in `@oh-my-pi/pi-coding-agent/tui`, but they
 * are unusable from a plugin: `isHyperlinkEnabled()` returns false until the host's `Settings`
 * singleton is initialized, and that singleton lives in the module graph that initialized it. The
 * host runs its npm bundle (`dist/cli.js`) while a plugin import of `@oh-my-pi/pi-coding-agent/tui`
 * resolves to `./src/tui/index.ts` — a second, never-initialized copy — so every host-wrapped link
 * degrades silently to plain text (the same duplicate-singleton trap as `AgentRegistry.global()`).
 *
 * Gate on process/terminal facts instead: those are derived from `Bun.env` at import time and are
 * therefore identical in both graphs.
 */

const OSC = "\u001b]";
const ST = "\u001b\\";
const OSC8_PREFIX = `${OSC}8;`;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface HyperlinkSupportOptions {
	/** Env source. Defaults to `Bun.env`. */
	readonly env?: Record<string, string | undefined>;
	/** Whether stdout is a TTY. Defaults to `process.stdout.isTTY`. */
	readonly isTty?: boolean;
	/** Terminal OSC 8 capability. Defaults to `TERMINAL.hyperlinks` from `@oh-my-pi/pi-tui`. */
	readonly terminalHyperlinks?: boolean;
}

/**
 * Whether OSC 8 hyperlinks should be emitted, mirroring the host's `"auto"` policy: the documented
 * `PI_NO_HYPERLINKS` / `PI_FORCE_HYPERLINKS` overrides (opt-out wins), then `NO_COLOR`, then a TTY
 * requirement, then the detected terminal capability. `TERMINAL.hyperlinks` already folds in the
 * env overrides and the tmux >= 3.4 gate; they are re-checked here so an injected `env` behaves the
 * same as the process env.
 */
export function resolveHyperlinkSupport(options: HyperlinkSupportOptions = {}): boolean {
	const env = options.env ?? Bun.env;
	if (env.PI_NO_HYPERLINKS === "1") return false;
	if (env.PI_FORCE_HYPERLINKS === "1") return true;
	if (env.NO_COLOR) return false;
	if (!(options.isTty ?? process.stdout.isTTY === true)) return false;
	return options.terminalHyperlinks ?? TERMINAL.hyperlinks;
}

let supported: boolean | undefined;

/** Process-wide {@link resolveHyperlinkSupport} result; resolved once, on first render. */
export function hyperlinksSupported(): boolean {
	supported ??= resolveHyperlinkSupport();
	return supported;
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `uri`, matching the host's byte shape so nested
 * host output stays consistent. Returns `text` unchanged when it already carries an OSC 8 sequence
 * (no double-wrapping) or when `uri` is empty or contains control characters, which would terminate
 * the escape early.
 */
export function osc8Hyperlink(uri: string, text: string): string {
	if (text.includes(OSC8_PREFIX)) return text;
	if (uri.length === 0 || CONTROL_CHARS.test(uri)) return text;
	const id = Bun.hash(uri).toString(16).slice(0, 8);
	return `${OSC}8;id=${id};${uri}${ST}${text}${OSC}8;;${ST}`;
}
