/**
 * DEC private mode 2026 synchronized-output bracketing helpers.
 *
 * Terminals supporting DEC 2026 batch visible updates when wrapped in
 * `\x1b[?2026h` (begin) … `\x1b[?2026l` (end), eliminating flicker.
 * Terminals that don't recognize 2026 ignore these sequences harmlessly.
 *
 * **Critical constraint:** these helpers must only ever wrap a COMPLETE frame
 * write, never partial or streaming writes. Bracketing individual lines or
 * partial updates will corrupt display state on supporting terminals.
 *
 * **Current plugin I/O boundary:** this plugin renders every frame via
 * `ctx.ui.setWidget(key, content, options)` — the host paints; the plugin owns
 * no raw I/O boundary today. `withSyncedFrame` is the ready I/O-boundary
 * primitive; `wrapSyncedFrame` is the form usable at the `setWidget` boundary
 * once the host is confirmed to pass widget content through verbatim.
 */

/** DEC private mode 2026 begin synchronized output. */
export const SYNC_BEGIN = "\x1b[?2026h";

/** DEC private mode 2026 end synchronized output. */
export const SYNC_END = "\x1b[?2026l";

/** Default emit target writes to process.stdout. */
function defaultEmit(bytes: string): void {
	process.stdout.write(bytes);
}

/**
 * Wrap a complete frame write in DEC 2026 synchronized-output brackets.
 *
 * Emits `SYNC_BEGIN`, calls `write()`, and emits `SYNC_END` in a `finally`
 * block so an exception can never leave an unterminated 2026h freezing
 * visible updates.
 *
 * @param write - The write callback. Must complete the entire frame.
 * @param emit - Injectable emit target; defaults to `process.stdout.write`.
 *
 * @example
 * ```ts
 * withSyncedFrame(() => {
 *   process.stdout.write(renderFrame());
 * });
 * ```
 */
export function withSyncedFrame(write: () => void, emit: (bytes: string) => void = defaultEmit): void {
	emit(SYNC_BEGIN);
	try {
		write();
	} finally {
		emit(SYNC_END);
	}
}

/**
 * Wrap a complete rendered frame string in DEC 2026 synchronized-output brackets.
 *
 * Returns `SYNC_BEGIN + frame + SYNC_END`. This is the form usable at the
 * `setWidget` boundary if/when the host is confirmed to pass widget content
 * through verbatim.
 *
 * @param frame - The complete rendered frame string.
 * @returns The bracketed frame.
 *
 * @example
 * ```ts
 * const bracketed = wrapSyncedFrame(renderFrame());
 * ctx.ui.setWidget("my-widget", bracketed);
 * ```
 */
export function wrapSyncedFrame(frame: string): string {
	return SYNC_BEGIN + frame + SYNC_END;
}
