import { describe, expect, it } from "bun:test";
import { type EvidenceTapeV1, replayEvidenceTape } from "../src/animations-box/evidence-replay";

const TAPE = {
	version: 1,
	steps: [
		{
			type: "observe",
			at: 0,
			kind: "retry-schedule",
			slot: 0,
			payload: { attempt: 2, delayMs: 4 },
		},
		{ type: "frame", at: 500 },
		{ type: "frame", at: 1_000 },
		{ type: "switch-session", at: 1_001 },
		{ type: "frame", at: 1_001 },
	],
} satisfies EvidenceTapeV1;

describe("evidence tape replay", () => {
	it("produces deterministic fake-time transitions, hashes, and frame versions", () => {
		const first = replayEvidenceTape(TAPE);
		const second = replayEvidenceTape(TAPE);
		expect(first).toEqual(second);
		if (!first.ok) throw new Error(first.issue);
		expect(first.transitions.map(row => row.frameVersion)).toEqual([1, 1, 2, 3, 3]);
		expect(first.transitions.map(row => row.fresh)).toEqual([1, 1, 0, 0, 0]);
		expect(first.transitions.map(row => row.recent)).toEqual([0, 0, 1, 0, 0]);
		expect(first.transitions[0].frameHash).toBe(first.transitions[1].frameHash);
		expect(first.transitions[1].frameHash).not.toBe(first.transitions[2].frameHash);
		expect(first.transitions[2].frameHash).not.toBe(first.transitions[3].frameHash);
		for (const row of first.transitions) {
			expect(row.frameHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
			expect(row.tapeVersion).toBe(1);
			expect(row.frameHashVersion).toBe(1);
		}
	});

	it("rejects unsupported, malformed, non-monotonic, and forbidden tape shapes", () => {
		expect(replayEvidenceTape({ version: 2, steps: [] })).toEqual({ ok: false, issue: "unsupported-version" });
		expect(replayEvidenceTape({ version: 1, steps: "not-an-array" })).toEqual({
			ok: false,
			issue: "invalid-tape",
		});
		expect(
			replayEvidenceTape({
				version: 1,
				steps: [
					{ type: "frame", at: 4 },
					{ type: "frame", at: 3 },
				],
			}),
		).toEqual({
			ok: false,
			issue: "non-monotonic-time",
			step: 1,
		});
		expect(
			replayEvidenceTape({
				version: 1,
				steps: [
					{
						type: "observe",
						at: 0,
						kind: "retry-schedule",
						slot: 0,
						payload: { attempt: 1, delayMs: 2, query: "forbidden" },
					},
				],
			}),
		).toEqual({ ok: false, issue: "invalid-evidence", step: 0 });
	});

	it("never reflects private sentinel material into diagnostic output", () => {
		const sentinel = "PRIVATE_SENTINEL_DO_NOT_COPY";
		const result = replayEvidenceTape({
			version: 1,
			steps: [
				{
					type: "observe",
					at: 0,
					kind: "skill-invocation",
					slot: 0,
					payload: { phase: "started", source: "managed", content: sentinel },
				},
			],
		});
		expect(result).toEqual({ ok: false, issue: "invalid-evidence", step: 0 });
		expect(JSON.stringify(result)).not.toContain(sentinel);
	});

	it("freezes successful transition logs and stops changing after dispose", () => {
		const result = replayEvidenceTape({
			version: 1,
			steps: [
				{ type: "dispose", at: 0 },
				{ type: "frame", at: 10 },
				{ type: "frame", at: 20 },
			],
		});
		if (!result.ok) throw new Error(result.issue);
		expect(result.transitions.map(row => row.frameVersion)).toEqual([1, 1, 1]);
		expect(result.transitions.every(row => row.disposed)).toBeTrue();
		expect(Object.isFrozen(result)).toBeTrue();
		expect(Object.isFrozen(result.transitions)).toBeTrue();
		expect(Object.isFrozen(result.transitions[0])).toBeTrue();
	});
});
