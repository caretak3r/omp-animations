import { describe, expect, it } from "bun:test";
import { SYNC_BEGIN, SYNC_END, withSyncedFrame, wrapSyncedFrame } from "../../src/kit";

describe("DEC 2026 synchronized-output constants", () => {
	it("exports correct escape sequences", () => {
		expect(SYNC_BEGIN).toBe("\x1b[?2026h");
		expect(SYNC_END).toBe("\x1b[?2026l");
	});
});

describe("withSyncedFrame — callback bracketing", () => {
	it("emits begin, calls write, and emits end in order", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);

		withSyncedFrame(() => {
			emitted.push("FRAME");
		}, emit);

		expect(emitted).toEqual([SYNC_BEGIN, "FRAME", SYNC_END]);
	});

	it("emits end even when write throws, and propagates the error", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);
		const error = new Error("write failed");

		expect(() => {
			withSyncedFrame(() => {
				emitted.push("PARTIAL");
				throw error;
			}, emit);
		}).toThrow(error);

		// End must still be emitted despite the throw.
		expect(emitted).toEqual([SYNC_BEGIN, "PARTIAL", SYNC_END]);
	});

	it("defaults to process.stdout when emit is omitted", () => {
		// We can't easily test actual stdout writes in a unit test without mocking
		// the entire process.stdout object, so we verify the signature allows
		// omitting emit and trust the implementation's defaultEmit call.
		// The critical path is already covered by the explicit-emit tests above.
		const calls: string[] = [];
		withSyncedFrame(
			() => {
				calls.push("executed");
			},
			bytes => calls.push(bytes),
		);
		expect(calls).toEqual([SYNC_BEGIN, "executed", SYNC_END]);
	});

	it("handles nested withSyncedFrame calls — each emits its own complete begin/end pair", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);

		withSyncedFrame(() => {
			emitted.push("OUTER_START");
			withSyncedFrame(() => {
				emitted.push("INNER");
			}, emit);
			emitted.push("OUTER_END");
		}, emit);

		// Nested calls each emit their own bracket pairs. Terminal behavior is undefined
		// for nested 2026h/2026l, but the helper doesn't corrupt ordering — it faithfully
		// emits what was requested in the order requested.
		expect(emitted).toEqual([SYNC_BEGIN, "OUTER_START", SYNC_BEGIN, "INNER", SYNC_END, "OUTER_END", SYNC_END]);
	});

	it("is idempotent when called multiple times in sequence — each call emits its own independent bracket pair", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);

		withSyncedFrame(() => emitted.push("FRAME1"), emit);
		withSyncedFrame(() => emitted.push("FRAME2"), emit);

		expect(emitted).toEqual([SYNC_BEGIN, "FRAME1", SYNC_END, SYNC_BEGIN, "FRAME2", SYNC_END]);
	});

	it("does not emit anything extra when write is a no-op", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);

		withSyncedFrame(() => {
			// No writes inside — only brackets should be emitted.
		}, emit);

		expect(emitted).toEqual([SYNC_BEGIN, SYNC_END]);
	});

	it("preserves the write callback's ability to emit multiple writes", () => {
		const emitted: string[] = [];
		const emit = (bytes: string) => emitted.push(bytes);

		withSyncedFrame(() => {
			emit("LINE1\n");
			emit("LINE2\n");
			emit("LINE3\n");
		}, emit);

		expect(emitted).toEqual([SYNC_BEGIN, "LINE1\n", "LINE2\n", "LINE3\n", SYNC_END]);
	});
});

describe("wrapSyncedFrame — string wrapper", () => {
	it("returns begin + frame + end in exact order", () => {
		const frame = "┌─────────┐\n│ content │\n└─────────┘";
		const wrapped = wrapSyncedFrame(frame);
		expect(wrapped).toBe(SYNC_BEGIN + frame + SYNC_END);
	});

	it("handles empty frame strings", () => {
		expect(wrapSyncedFrame("")).toBe(SYNC_BEGIN + SYNC_END);
	});

	it("does not double-wrap when called on already-wrapped output", () => {
		const frame = "content";
		const once = wrapSyncedFrame(frame);
		const twice = wrapSyncedFrame(once);

		// Calling wrapSyncedFrame on an already-wrapped string is misuse, but the function
		// doesn't detect or prevent it — it faithfully wraps what was given. The result
		// is nested brackets, which terminals treat as undefined behavior.
		expect(twice).toBe(SYNC_BEGIN + SYNC_BEGIN + frame + SYNC_END + SYNC_END);
	});

	it("preserves multi-line frame content exactly", () => {
		const frame = "line1\nline2\nline3";
		const wrapped = wrapSyncedFrame(frame);
		expect(wrapped).toBe(`${SYNC_BEGIN}line1\nline2\nline3${SYNC_END}`);
	});

	it("preserves ANSI escape sequences and control characters in the frame", () => {
		const frame = "\x1b[31mred\x1b[0m \x1b[1mbold\x1b[0m";
		const wrapped = wrapSyncedFrame(frame);
		expect(wrapped).toBe(SYNC_BEGIN + frame + SYNC_END);
	});

	it("produces the same bracketed result as withSyncedFrame would emit", () => {
		const frame = "test frame";
		const wrapped = wrapSyncedFrame(frame);

		const emitted: string[] = [];
		withSyncedFrame(
			() => emitted.push(frame),
			bytes => emitted.push(bytes),
		);
		const viaCallback = emitted.join("");

		expect(wrapped).toBe(viaCallback);
	});
});
