import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext, WidgetPlacement } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type {
	BashToolResultEvent,
	EditToolResultEvent,
	ReadToolResultEvent,
	ToolResultEvent,
	WriteToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AccentColor } from "../appearance";
import type { MotionSetting } from "../kit";
import { type AuditTrailBoxContext, AuditTrailBoxController } from "./controller";
import { hashContent, type ProbeSource } from "./probe";
import { formatRemedyPlan } from "./remedy";
import type { TouchObservation } from "./state";

export * from "./controller";
export * from "./probe";
export * from "./remedy";
export * from "./state";
export * from "./widget";

/** The slash command this extension registers. */
export const AUDIT_TRAIL_COMMAND = "audit-trail";

/**
 * `bash` invocations that dump a whole file to stdout, i.e. a read the `read`
 * tool never sees. Kept deliberately short: the point is to catch the agent
 * reading a file the ledger would otherwise miss, not to become a shell parser.
 */
const BASH_READ_COMMANDS: ReadonlySet<string> = new Set(["cat", "bat", "head", "tail", "less", "more"]);

/** Any of these means the command is doing something other than dumping one named file. */
const SHELL_METACHARACTERS = /[|&;<>$`"'*?(){}[\]\\\n]/;

/** One tracked touch, already resolved to an absolute path. */
export interface AuditTouch {
	readonly path: string;
	readonly kind: "read" | "write";
	readonly observed: TouchObservation;
}

/**
 * Absolute, stable key for a tracked path — or `undefined` when the path must
 * not be tracked at all.
 *
 * Two refusals matter, and both exist to protect precision rather than tidiness:
 * a URI/URL has no file to probe, and a trailing `:` segment is the `read`
 * tool's legacy inline selector (`file.ts:20-40`). Tracking the latter verbatim
 * would invent a path that no probe can ever reach, and an unreachable path is
 * exactly what the tracker reports as POISONED — a false alarm manufactured out
 * of nothing. Filenames may legitimately contain colons, so the selector cannot
 * be stripped safely either; refusing is the only honest option, and it costs
 * only the rare read whose `resolvedPath` the tool did not report.
 */
export function resolveTrackedPath(raw: string | undefined, cwd: string): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.includes("://")) return undefined;
	const lastSegment = trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
	if (lastSegment.includes(":")) return undefined;
	return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/**
 * The single file a `bash` command dumped, when it plainly dumped exactly one.
 * Anything with a pipe, a redirect, a glob, quoting, or more than one non-flag
 * argument is refused — a `cat a b` or a `head -n 20 file` is ambiguous about
 * what the agent actually received, and a wrong guess pollutes the ledger.
 */
export function bashReadTarget(command: string): string | undefined {
	if (SHELL_METACHARACTERS.test(command)) return undefined;
	const tokens = command.trim().split(/\s+/);
	const [head, ...rest] = tokens;
	if (head === undefined || !BASH_READ_COMMANDS.has(head)) return undefined;
	const operands = rest.filter(token => !token.startsWith("-"));
	return operands.length === 1 ? operands[0] : undefined;
}

/**
 * Whether a `read` result carries the whole file, so its body may be hashed as
 * the agent's copy. A partial read (selector, truncation, elision, an offset
 * start line) still counts as a touch — it feeds the read ledger and the cold
 * clock — but supplying a hash for it would compare a fragment against the
 * whole file on disk and diverge instantly.
 */
function isWholeFileRead(event: ReadToolResultEvent): boolean {
	const details = event.details;
	if (details?.displayContent === undefined) return false;
	if (details.displayContent.startLine !== 1) return false;
	if (details.truncation?.truncated === true) return false;
	if (details.summary !== undefined) return false;
	if (details.displayReadTargets !== undefined) return false;
	return typeof event.input.selector !== "string";
}

function readTouches(event: ReadToolResultEvent, cwd: string): readonly AuditTouch[] {
	const details = event.details;
	if (details?.isDirectory === true || details?.kind === "url" || details?.url !== undefined) return [];

	// A delimited read argument fans out to several files in one call. None of
	// them can be matched to a slice of the body, so all are tracked hashless.
	if (details?.displayReadTargets !== undefined) {
		const touches: AuditTouch[] = [];
		for (const target of details.displayReadTargets) {
			const path = resolveTrackedPath(target, cwd);
			if (path !== undefined) touches.push({ path, kind: "read", observed: {} });
		}
		return touches;
	}

	const path = resolveTrackedPath(details?.resolvedPath ?? asString(event.input.path), cwd);
	if (path === undefined) return [];
	if (!isWholeFileRead(event)) return [{ path, kind: "read", observed: {} }];
	const content = details?.displayContent?.text ?? "";
	return [{ path, kind: "read", observed: { hash: hashContent(content), content } }];
}

function writeTouches(event: WriteToolResultEvent, cwd: string): readonly AuditTouch[] {
	const path = resolveTrackedPath(asString(event.input.path), cwd);
	if (path === undefined) return [];
	const content = asString(event.input.content);
	if (content === undefined) return [{ path, kind: "write", observed: {} }];
	return [{ path, kind: "write", observed: { hash: hashContent(content), content } }];
}

function editTouches(event: EditToolResultEvent, cwd: string): readonly AuditTouch[] {
	const details = event.details;

	if (details?.perFileResults !== undefined) {
		const touches: AuditTouch[] = [];
		for (const result of details.perFileResults) {
			if (result.isError === true) continue;
			const path = resolveTrackedPath(result.path, cwd);
			if (path === undefined) continue;
			touches.push({ path, kind: "write", observed: snapshotOf(result.newText, result.snapshotsPruned) });
		}
		return touches;
	}

	const path = resolveTrackedPath(details?.path ?? asString(event.input.path), cwd);
	if (path === undefined) return [];
	return [{ path, kind: "write", observed: snapshotOf(details?.newText, details?.snapshotsPruned) }];
}

function bashTouches(event: BashToolResultEvent, cwd: string): readonly AuditTouch[] {
	const command = asString(event.input.command);
	if (command === undefined) return [];
	const target = bashReadTarget(command);
	const path = resolveTrackedPath(target, cwd);
	// Hashless on purpose: the body is interleaved with whatever else the shell
	// printed, so it feeds the read ledger and never the divergence probe.
	return path === undefined ? [] : [{ path, kind: "read", observed: {} }];
}

/**
 * A post-edit snapshot, unless the core pruned it for size — in which case the
 * write is still tracked, just without a baseline. A hashless write is the safe
 * degradation: the path shows up as DIRTY and the probe simply has nothing to
 * compare, rather than comparing against a snapshot that was never taken.
 */
function snapshotOf(newText: string | undefined, snapshotsPruned: boolean | undefined): TouchObservation {
	if (snapshotsPruned === true || newText === undefined) return {};
	return { hash: hashContent(newText), content: newText };
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Narrow a tool result to a built-in tool. The `toolName` discriminant alone
 * cannot do it — `CustomToolResultEvent.toolName` is a bare `string`, so a
 * plain `switch` leaves the union unnarrowed — and the core dropped its
 * `isToolResultEventType` helper from the published surface. Same predicate
 * idiom Diff Bloom's controller uses for `edit`.
 */
function isReadResult(event: ToolResultEvent): event is ReadToolResultEvent {
	return event.toolName === "read";
}

function isWriteResult(event: ToolResultEvent): event is WriteToolResultEvent {
	return event.toolName === "write";
}

function isEditResult(event: ToolResultEvent): event is EditToolResultEvent {
	return event.toolName === "edit";
}

function isBashResult(event: ToolResultEvent): event is BashToolResultEvent {
	return event.toolName === "bash";
}

/**
 * Everything the ledger should learn from one tool result. Pure: no clock, no
 * filesystem, no controller — which is what makes the adapter's per-tool
 * quirks (partial reads, multi-file edits, pruned snapshots, shell dumps)
 * testable one case at a time.
 *
 * A failed tool contributes nothing. The agent's context did not change, so
 * neither should the working set.
 */
export function auditTouchesFromToolResult(event: ToolResultEvent, cwd: string): readonly AuditTouch[] {
	if (event.isError) return [];
	if (isReadResult(event)) return readTouches(event, cwd);
	if (isWriteResult(event)) return writeTouches(event, cwd);
	if (isEditResult(event)) return editTouches(event, cwd);
	if (isBashResult(event)) return bashTouches(event, cwd);
	return [];
}

function readMotionSetting(options: AuditTrailBoxExtensionOptions): MotionSetting {
	const value = options.motionSetting;
	return value === "off" || value === "subtle" || value === "full" ? value : "full";
}

function toAuditContext(ctx: ExtensionContext, options: AuditTrailBoxExtensionOptions): AuditTrailBoxContext {
	return {
		hasUI: ctx.hasUI,
		isTTY: process.stdout.isTTY === true,
		env: Bun.env,
		motionSetting: readMotionSetting(options),
		theme: ctx.ui.theme,
		glyphPreset: ctx.ui.theme.getSymbolPreset(),
		columns: process.stdout.columns,
		setWidget: (key, content, widgetOptions) => ctx.ui.setWidget(key, content, widgetOptions),
		setStatus: (key, text) => ctx.ui.setStatus(key, text),
	};
}

/**
 * Audit Trail Box: a live meter over the agent's own working set, classifying
 * every touched path as FRESH / DIRTY / POISONED / REDUNDANT / COLD.
 *
 * The ambient surface is a compact widget; a footer status line escalates only
 * while something is genuinely stale (see `controller.ts` for why the two are
 * not copies of each other), and `/audit-trail` opens the full risk-sorted
 * panel. `/audit-trail remedy` is the payload: it re-reads every path the agent
 * can no longer trust and prints what changed *before* the stale copy is
 * discarded, alongside the list of cold paths that are safe to drop.
 *
 * Evidence is gathered from tool results (`read`/`write`/`edit`, plus the
 * narrow set of `bash` invocations that dump a file), turn boundaries,
 * compactions and session teardown — never by asking the user to label
 * anything.
 */
export interface AuditTrailBoxExtensionOptions {
	/** Motion tier injected by the registrar; defaults to "full" when unset. */
	motionSetting?: MotionSetting;
	/** Widget placement injected by the registrar; defaults to "belowEditor" when unset. */
	placement?: WidgetPlacement;
	/** Accent override for the primary accent slot (the box badge); defaults to the built-in palette when unset. */
	accentColor?: AccentColor;
	/** Filesystem seam for the divergence probe. Defaults to the real one; tests inject a fake. */
	probeSource?: ProbeSource;
	/** Run headless — no widget row, ledger/probe/alarm unchanged. See `AuditTrailBoxController`'s own doc. */
	suppressRow?: boolean;
}

export function createAuditTrailBoxExtension(options: AuditTrailBoxExtensionOptions = {}): ExtensionFactory {
	return api => {
		const controller = new AuditTrailBoxController({
			placement: options.placement,
			accentColor: options.accentColor,
			probeSource: options.probeSource,
			suppressRow: options.suppressRow,
		});

		api.on("tool_result", (event, ctx) => {
			if (!ctx.hasUI) return;
			const audit = toAuditContext(ctx, options);
			for (const touch of auditTouchesFromToolResult(event, ctx.cwd)) {
				if (touch.kind === "read") controller.noteRead(touch.path, touch.observed, audit);
				else controller.noteWrite(touch.path, touch.observed, audit);
			}
		});

		api.on("turn_end", (_event, ctx) => {
			controller.noteTurn(toAuditContext(ctx, options));
		});

		// A compaction or a clear right after a poison flag is the derived
		// "the user recovered from a bad copy" signal — no prompt, no labelling.
		api.on("session_compact", (_event, ctx) => {
			controller.noteRecovery(toAuditContext(ctx, options));
		});
		api.on("auto_compaction_end", (_event, ctx) => {
			controller.noteRecovery(toAuditContext(ctx, options));
		});

		api.on("session_switch", (_event, ctx) => {
			controller.noteSessionSwitch(toAuditContext(ctx, options));
		});
		api.on("session_shutdown", (_event, ctx) => {
			controller.dispose(toAuditContext(ctx, options));
		});

		api.registerCommand(AUDIT_TRAIL_COMMAND, {
			description: "Working-set audit: the tracked paths, or `remedy` for what to re-read before touching it again",
			getArgumentCompletions: prefix =>
				"remedy".startsWith(prefix.trim())
					? [
							{
								value: "remedy",
								label: "remedy",
								description: "Re-read stale paths and diff them before discarding",
							},
						]
					: null,
			handler: async (args, ctx: ExtensionCommandContext) => {
				if (!ctx.hasUI) return;
				const audit = toAuditContext(ctx, options);
				if (args.trim().toLowerCase() === "remedy") {
					const plan = await controller.remedy(audit);
					ctx.ui.notify(formatRemedyPlan(plan).join("\n"), plan.mustReread.length > 0 ? "warning" : "info");
					return;
				}
				ctx.ui.notify(controller.panel(audit).join("\n"), "info");
			},
		});
	};
}
