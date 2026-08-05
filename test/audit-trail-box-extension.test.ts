import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	AUDIT_TRAIL_COMMAND,
	type AuditTrailBoxExtensionOptions,
	auditTouchesFromToolResult,
	bashReadTarget,
	createAuditTrailBoxExtension,
	resolveTrackedPath,
	STATUS_KEY,
	WIDGET_KEY,
} from "../src/audit-trail-box";
import { hashContent, type ProbeObservation, type ProbeSource } from "../src/audit-trail-box/probe";

const CWD = "/repo";

/** A tool-result event with only the fields the adapter reads. */
function toolResult(
	toolName: string,
	input: Record<string, unknown>,
	details?: unknown,
	isError = false,
): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: "call-1",
		toolName,
		input,
		content: [],
		isError,
		details,
	} as unknown as ToolResultEvent;
}

/** A whole-file `read` result: the shape the tool produces when it hands over an entire file. */
function wholeFileRead(path: string, text: string): ToolResultEvent {
	return toolResult("read", { path }, { kind: "file", resolvedPath: path, displayContent: { text, startLine: 1 } });
}

// ═══════════════════════════════════════════════════════════════════════════
// Path resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("audit trail box — tracked path resolution", () => {
	it("resolves relative paths against the session cwd and leaves absolute ones alone", () => {
		expect(resolveTrackedPath("src/a.ts", CWD)).toBe("/repo/src/a.ts");
		expect(resolveTrackedPath("./src/a.ts", CWD)).toBe("/repo/src/a.ts");
		expect(resolveTrackedPath("/elsewhere/a.ts", CWD)).toBe("/elsewhere/a.ts");
	});

	it("refuses URIs and URLs — there is no file behind them to probe", () => {
		expect(resolveTrackedPath("https://example.com/a.ts", CWD)).toBeUndefined();
		expect(resolveTrackedPath("omp://sessions", CWD)).toBeUndefined();
		expect(resolveTrackedPath("issue://123", CWD)).toBeUndefined();
	});

	it("refuses an inline `:<selector>` rather than inventing an unreachable path", () => {
		// The unreachable path is what the tracker reports as POISONED, so a phantom
		// path manufactured from a selector would be a false alarm out of thin air.
		expect(resolveTrackedPath("src/a.ts:20-40", CWD)).toBeUndefined();
		expect(resolveTrackedPath("src/a.ts:raw", CWD)).toBeUndefined();
	});

	it("still accepts a colon in a directory segment — only the filename is ambiguous", () => {
		expect(resolveTrackedPath("/repo/weird:dir/a.ts", CWD)).toBe("/repo/weird:dir/a.ts");
	});

	it("refuses empty and non-string input", () => {
		expect(resolveTrackedPath("", CWD)).toBeUndefined();
		expect(resolveTrackedPath("   ", CWD)).toBeUndefined();
		expect(resolveTrackedPath(undefined, CWD)).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// The bash file-dump heuristic
// ═══════════════════════════════════════════════════════════════════════════

describe("audit trail box — bash file-dump detection", () => {
	it("recognizes an unambiguous single-file dump", () => {
		expect(bashReadTarget("cat src/a.ts")).toBe("src/a.ts");
		expect(bashReadTarget("bat src/a.ts")).toBe("src/a.ts");
		expect(bashReadTarget("head -20 src/a.ts")).toBe("src/a.ts");
		expect(bashReadTarget("  tail   src/a.ts  ")).toBe("src/a.ts");
	});

	it("refuses anything ambiguous about which bytes the agent actually received", () => {
		expect(bashReadTarget("cat a.ts b.ts")).toBeUndefined();
		expect(bashReadTarget("head -n 20 a.ts")).toBeUndefined();
		expect(bashReadTarget("cat")).toBeUndefined();
	});

	it("refuses anything that is not plainly one command reading one named file", () => {
		expect(bashReadTarget("cat a.ts | grep foo")).toBeUndefined();
		expect(bashReadTarget("cat a.ts > out.txt")).toBeUndefined();
		expect(bashReadTarget("cat *.ts")).toBeUndefined();
		expect(bashReadTarget('cat "a b.ts"')).toBeUndefined();
		expect(bashReadTarget("cat $FILE")).toBeUndefined();
		expect(bashReadTarget("cat a.ts && rm a.ts")).toBeUndefined();
		expect(bashReadTarget("rg foo a.ts")).toBeUndefined();
		expect(bashReadTarget("bun test")).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// The tool-result adapter
// ═══════════════════════════════════════════════════════════════════════════

describe("audit trail box — read results", () => {
	it("hashes a whole-file read as the agent's copy", () => {
		const touches = auditTouchesFromToolResult(wholeFileRead("/repo/a.ts", "alpha\nbeta"), CWD);
		expect(touches).toEqual([
			{ path: "/repo/a.ts", kind: "read", observed: { hash: hashContent("alpha\nbeta"), content: "alpha\nbeta" } },
		]);
	});

	it("agrees with the probe's hash of the same file on disk, trailing newline and all", () => {
		// The read tool hands back line-joined text; the probe hashes the file's exact
		// bytes. If those two disagreed on the final newline, every ordinary read would
		// look like external divergence.
		const [touch] = auditTouchesFromToolResult(wholeFileRead("/repo/a.ts", "alpha\nbeta"), CWD);
		expect(touch?.observed.hash).toBe(hashContent("alpha\nbeta\n"));
	});

	it("tracks a partial read WITHOUT a hash — a fragment cannot be compared to a whole file", () => {
		const cases: ToolResultEvent[] = [
			// an explicit selector
			toolResult(
				"read",
				{ path: "/repo/a.ts", selector: "20-40" },
				{ resolvedPath: "/repo/a.ts", displayContent: { text: "beta", startLine: 1 } },
			),
			// an offset window
			toolResult(
				"read",
				{ path: "/repo/a.ts" },
				{ resolvedPath: "/repo/a.ts", displayContent: { text: "beta", startLine: 20 } },
			),
			// truncated by the tool
			toolResult(
				"read",
				{ path: "/repo/a.ts" },
				{
					resolvedPath: "/repo/a.ts",
					displayContent: { text: "alpha", startLine: 1 },
					truncation: { content: "alpha", truncated: true, totalLines: 900, totalBytes: 9000 },
				},
			),
			// elided middle spans
			toolResult(
				"read",
				{ path: "/repo/a.ts" },
				{
					resolvedPath: "/repo/a.ts",
					displayContent: { text: "alpha", startLine: 1 },
					summary: { lines: 900, elidedSpans: 3, elidedLines: 800 },
				},
			),
			// no body at all
			toolResult("read", { path: "/repo/a.ts" }, { resolvedPath: "/repo/a.ts" }),
		];

		for (const event of cases) {
			expect(auditTouchesFromToolResult(event, CWD)).toEqual([{ path: "/repo/a.ts", kind: "read", observed: {} }]);
		}
	});

	it("ignores directory listings and remote reads", () => {
		expect(
			auditTouchesFromToolResult(
				toolResult("read", { path: "src" }, { isDirectory: true, resolvedPath: "/repo/src" }),
				CWD,
			),
		).toEqual([]);
		expect(
			auditTouchesFromToolResult(
				toolResult("read", { path: "https://example.com/a.ts" }, { kind: "url", url: "https://example.com/a.ts" }),
				CWD,
			),
		).toEqual([]);
	});

	it("fans a multi-target read out to one hashless touch per file", () => {
		const touches = auditTouchesFromToolResult(
			toolResult(
				"read",
				{ path: "a.ts,b.ts" },
				{ displayReadTargets: ["a.ts", "/elsewhere/b.ts", "https://example.com/c.ts"] },
			),
			CWD,
		);
		expect(touches).toEqual([
			{ path: "/repo/a.ts", kind: "read", observed: {} },
			{ path: "/elsewhere/b.ts", kind: "read", observed: {} },
		]);
	});

	it("falls back to the input path when the tool reported no resolved one", () => {
		const touches = auditTouchesFromToolResult(
			toolResult("read", { path: "src/a.ts" }, { displayContent: { text: "alpha", startLine: 1 } }),
			CWD,
		);
		expect(touches[0]?.path).toBe("/repo/src/a.ts");
	});
});

describe("audit trail box — write and edit results", () => {
	it("takes the written content as the agent's copy", () => {
		const touches = auditTouchesFromToolResult(
			toolResult("write", { path: "src/a.ts", content: "alpha\n" }, undefined),
			CWD,
		);
		expect(touches).toEqual([
			{ path: "/repo/src/a.ts", kind: "write", observed: { hash: hashContent("alpha\n"), content: "alpha\n" } },
		]);
	});

	it("takes a single-file edit's post-edit snapshot", () => {
		const touches = auditTouchesFromToolResult(
			toolResult("edit", { path: "src/a.ts" }, { diff: "…", path: "/repo/src/a.ts", newText: "beta\n" }),
			CWD,
		);
		expect(touches).toEqual([
			{ path: "/repo/src/a.ts", kind: "write", observed: { hash: hashContent("beta\n"), content: "beta\n" } },
		]);
	});

	it("falls back to the edit's input path when details carry none", () => {
		const touches = auditTouchesFromToolResult(toolResult("edit", { path: "src/a.ts" }, { diff: "…" }), CWD);
		expect(touches).toEqual([{ path: "/repo/src/a.ts", kind: "write", observed: {} }]);
	});

	it("splits a multi-file edit per file and skips the entries that failed", () => {
		const touches = auditTouchesFromToolResult(
			toolResult(
				"edit",
				{},
				{
					diff: "…",
					perFileResults: [
						{ path: "/repo/a.ts", diff: "…", newText: "a2" },
						{ path: "/repo/b.ts", diff: "…", isError: true, newText: "b2" },
						{ path: "c.ts", diff: "…", newText: "c2" },
					],
				},
			),
			CWD,
		);
		expect(touches).toEqual([
			{ path: "/repo/a.ts", kind: "write", observed: { hash: hashContent("a2"), content: "a2" } },
			{ path: "/repo/c.ts", kind: "write", observed: { hash: hashContent("c2"), content: "c2" } },
		]);
	});

	it("tracks a write whose snapshot the core pruned, but without a baseline", () => {
		const pruned = auditTouchesFromToolResult(
			toolResult(
				"edit",
				{ path: "a.ts" },
				{ diff: "…", path: "/repo/a.ts", newText: "huge", snapshotsPruned: true },
			),
			CWD,
		);
		expect(pruned).toEqual([{ path: "/repo/a.ts", kind: "write", observed: {} }]);

		// A delete has no post-edit content either — same safe degradation.
		const deleted = auditTouchesFromToolResult(
			toolResult("edit", { path: "a.ts" }, { diff: "…", path: "/repo/a.ts", op: "delete" }),
			CWD,
		);
		expect(deleted).toEqual([{ path: "/repo/a.ts", kind: "write", observed: {} }]);
	});
});

describe("audit trail box — bash and non-file results", () => {
	it("counts a shell file dump as a hashless read", () => {
		expect(auditTouchesFromToolResult(toolResult("bash", { command: "cat src/a.ts" }), CWD)).toEqual([
			{ path: "/repo/src/a.ts", kind: "read", observed: {} },
		]);
	});

	it("ignores every other shell command", () => {
		expect(auditTouchesFromToolResult(toolResult("bash", { command: "bun test" }), CWD)).toEqual([]);
		expect(auditTouchesFromToolResult(toolResult("bash", { command: "cat a.ts | wc -l" }), CWD)).toEqual([]);
	});

	it("ignores failed tools — the agent's context did not change", () => {
		expect(
			auditTouchesFromToolResult(toolResult("read", { path: "a.ts" }, { resolvedPath: "/repo/a.ts" }, true), CWD),
		).toEqual([]);
		expect(
			auditTouchesFromToolResult(toolResult("write", { path: "a.ts", content: "x" }, undefined, true), CWD),
		).toEqual([]);
	});

	it("ignores tools that touch no file", () => {
		expect(auditTouchesFromToolResult(toolResult("grep", { pattern: "foo" }), CWD)).toEqual([]);
		expect(auditTouchesFromToolResult(toolResult("glob", { pattern: "**/*.ts" }), CWD)).toEqual([]);
		expect(auditTouchesFromToolResult(toolResult("some_mcp_tool", { path: "a.ts" }), CWD)).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Extension wiring
// ═══════════════════════════════════════════════════════════════════════════

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandOptions = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

/** In-memory disk for the divergence probe; a path absent from the map is unreachable. */
function fakeDisk(initial: Record<string, string> = {}): ProbeSource {
	const files = new Map(Object.entries(initial));
	return {
		async inspect(path: string): Promise<ProbeObservation | undefined> {
			const content = files.get(path);
			return content === undefined ? undefined : { hash: hashContent(content), content };
		},
	};
}

function mountExtension(options: AuditTrailBoxExtensionOptions = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandOptions>();
	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, commandOptions: CommandOptions) => {
			commands.set(name, commandOptions);
		},
		logger: { error() {}, warn() {}, debug() {}, info() {} },
	} as unknown as ExtensionAPI;

	createAuditTrailBoxExtension(options)(api);

	const command = commands.get(AUDIT_TRAIL_COMMAND);
	if (command === undefined) throw new Error(`/${AUDIT_TRAIL_COMMAND} was never registered`);

	return {
		events: [...handlers.keys()],
		commands: [...commands.keys()],
		command,
		emit(event: string, payload: unknown, ctx: ExtensionContext): void {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}

function recordingContext(overrides: Partial<ExtensionContext> = {}) {
	const widgets: Array<{ key: string; content: unknown }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const notes: Array<{ message: string; type: string | undefined }> = [];
	const ctx = {
		hasUI: true,
		cwd: CWD,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (key: string, content: unknown) => widgets.push({ key, content }),
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			notify: (message: string, type?: string) => notes.push({ message, type }),
		},
		...overrides,
	} as unknown as ExtensionContext;
	return { ctx, widgets, statuses, notes };
}

/** The text of the last `ui.notify` call. */
function lastNote(notes: Array<{ message: string; type: string | undefined }>) {
	const note = notes.at(-1);
	if (note === undefined) throw new Error("nothing was notified");
	return note;
}

describe("audit trail box extension — wiring", () => {
	it("subscribes to the evidence events and registers its slash command", () => {
		const mounted = mountExtension();
		expect(mounted.events.sort()).toEqual(
			[
				"auto_compaction_end",
				"session_compact",
				"session_shutdown",
				"session_switch",
				"tool_result",
				"turn_end",
			].sort(),
		);
		expect(mounted.commands).toEqual([AUDIT_TRAIL_COMMAND]);
	});

	it("offers `remedy` as an argument completion", () => {
		const { command } = mountExtension();
		expect(command.getArgumentCompletions?.("")?.map(item => item.value)).toEqual(["remedy"]);
		expect(command.getArgumentCompletions?.("rem")?.map(item => item.value)).toEqual(["remedy"]);
		expect(command.getArgumentCompletions?.("xyz")).toBeNull();
	});

	it("feeds tool results into the ledger, keyed by absolute path", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk({ "/repo/src/a.ts": "alpha\n" }) });
		const { ctx, notes } = recordingContext();

		mounted.emit("tool_result", toolResult("write", { path: "src/a.ts", content: "alpha\n" }), ctx);
		await mounted.command.handler("", ctx as ExtensionCommandContext);

		expect(lastNote(notes).message).toContain("/repo/src/a.ts");
	});

	it("advances the turn clock on turn_end", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk() });
		const { ctx, notes } = recordingContext();

		mounted.emit("tool_result", wholeFileRead("/repo/a.ts", "alpha"), ctx);
		mounted.emit("turn_end", {}, ctx);
		mounted.emit("turn_end", {}, ctx);
		await mounted.command.handler("", ctx as ExtensionCommandContext);

		expect(lastNote(notes).message).toContain("turn 2");
	});

	it("stays completely dormant without a UI surface", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk({ "/repo/a.ts": "alpha" }) });
		const headless = recordingContext({ hasUI: false });

		mounted.emit("tool_result", wholeFileRead("/repo/a.ts", "alpha"), headless.ctx);
		mounted.emit("tool_result", toolResult("write", { path: "b.ts", content: "beta" }), headless.ctx);
		mounted.emit("turn_end", {}, headless.ctx);
		mounted.emit("session_compact", {}, headless.ctx);
		await mounted.command.handler("", headless.ctx as ExtensionCommandContext);

		expect(headless.widgets).toEqual([]);
		expect(headless.statuses).toEqual([]);
		expect(headless.notes).toEqual([]);

		// And nothing was recorded behind the scenes either: a UI-bearing read-back
		// shows an empty working set, not a hidden one that was tracked all along.
		const visible = recordingContext();
		await mounted.command.handler("", visible.ctx as ExtensionCommandContext);
		expect(lastNote(visible.notes).message).toContain("0 paths");
	});

	it("clears both surfaces on session shutdown", () => {
		const mounted = mountExtension({ probeSource: fakeDisk() });
		const { ctx, widgets, statuses } = recordingContext();

		mounted.emit("tool_result", wholeFileRead("/repo/a.ts", "alpha"), ctx);
		expect(widgets.some(entry => entry.key === WIDGET_KEY)).toBe(true);

		mounted.emit("session_shutdown", {}, ctx);
		expect(widgets.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });
		expect(statuses.at(-1)).toEqual({ key: STATUS_KEY, text: undefined });
	});
});

describe("audit trail box extension — the /audit-trail command", () => {
	it("renders the panel by default", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk({ "/repo/a.ts": "alpha" }) });
		const { ctx, notes } = recordingContext();

		mounted.emit("tool_result", wholeFileRead("/repo/a.ts", "alpha"), ctx);
		await mounted.command.handler("", ctx as ExtensionCommandContext);

		const note = lastNote(notes);
		expect(note.type).toBe("info");
		expect(note.message).toContain("audit trail box");
		expect(note.message).toContain("/repo/a.ts");
	});

	it("diffs a stale copy BEFORE it is discarded, and says so loudly", async () => {
		// The agent wrote "alpha"; something else has since made it "beta". The remedy
		// must report what moved while the agent still holds the old bytes.
		const mounted = mountExtension({ probeSource: fakeDisk({ "/repo/a.ts": "beta\n" }) });
		const { ctx, notes } = recordingContext();

		mounted.emit("tool_result", toolResult("write", { path: "a.ts", content: "alpha\n" }), ctx);
		await mounted.command.handler("remedy", ctx as ExtensionCommandContext);

		const note = lastNote(notes);
		expect(note.type).toBe("warning");
		expect(note.message).toContain("must re-read");
		expect(note.message).toContain("/repo/a.ts");
		expect(note.message).toContain("-alpha");
		expect(note.message).toContain("+beta");
	});

	it("reports a clean working set as information, not an alarm", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk({ "/repo/a.ts": "alpha" }) });
		const { ctx, notes } = recordingContext();

		mounted.emit("tool_result", wholeFileRead("/repo/a.ts", "alpha"), ctx);
		await mounted.command.handler("remedy", ctx as ExtensionCommandContext);

		const note = lastNote(notes);
		expect(note.type).toBe("info");
		expect(note.message).toContain("must re-read: nothing");
	});

	it("says nothing at all without a UI surface", async () => {
		const mounted = mountExtension({ probeSource: fakeDisk() });
		const { ctx, notes } = recordingContext({ hasUI: false });

		await mounted.command.handler("", ctx as ExtensionCommandContext);
		await mounted.command.handler("remedy", ctx as ExtensionCommandContext);

		expect(notes).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Content identity
// ═══════════════════════════════════════════════════════════════════════════

describe("audit trail box — content identity", () => {
	it("ignores trailing newlines, which the read tool and the disk disagree about", () => {
		expect(hashContent("alpha\nbeta")).toBe(hashContent("alpha\nbeta\n"));
		expect(hashContent("alpha\nbeta")).toBe(hashContent("alpha\nbeta\n\n"));
		expect(hashContent("alpha\nbeta")).toBe(hashContent("alpha\nbeta\r\n"));
	});

	it("still separates content that genuinely differs", () => {
		expect(hashContent("alpha\nbeta")).not.toBe(hashContent("alpha\nbetb"));
		expect(hashContent("alpha\nbeta")).not.toBe(hashContent("alpha\n\nbeta"));
		expect(hashContent("alpha\nbeta")).not.toBe(hashContent("alpha\nbeta \n"));
	});
});
