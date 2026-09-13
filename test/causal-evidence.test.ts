import { describe, expect, it } from "bun:test";
import {
	type CausalEvidenceEndpoint,
	type CausalEvidenceLedger,
	type CausalEvidenceRenderOptions,
	createCausalEvidenceLedger,
	joinCausalEvidence,
	renderCausalEvidence,
} from "../src/signal-extras/causal-evidence";

const WIDE_UNICODE: CausalEvidenceRenderOptions = {
	now: 0,
	width: 80,
	unicode: true,
	color: true,
	reducedMotion: true,
	phase: 0,
};

function add(
	ledger: CausalEvidenceLedger,
	session: string | undefined,
	relation: string | undefined,
	kind: CausalEvidenceEndpoint["kind"],
	now: number,
): CausalEvidenceLedger {
	return joinCausalEvidence(ledger, { session, relation, kind }, now);
}

function texts(ledger: CausalEvidenceLedger, options: Partial<CausalEvidenceRenderOptions> = {}): string[] {
	return renderCausalEvidence(ledger, { ...WIDE_UNICODE, ...options }).topologies.map(row => row.text);
}

describe("causal evidence exact-key joiner", () => {
	it("renders only the admitted tool, retry, and cancellation sequences", () => {
		let ledger = createCausalEvidenceLedger();
		ledger = add(ledger, "session-a", "tool-1", "tool-local-start", 0);
		ledger = add(ledger, "session-a", "tool-1", "tool-local-start", 1);
		ledger = add(ledger, "session-a", "tool-1", "tool-local-result", 2);
		ledger = add(ledger, "session-a", "retry-1", "retry-reschedule", 3);
		ledger = add(ledger, "session-a", "retry-1", "retry-dispatch", 4);
		ledger = add(ledger, "session-a", "retry-1", "retry-outcome", 5);
		ledger = add(ledger, "session-a", "cancel-1", "cancellation-request", 6);
		ledger = add(ledger, "session-a", "cancel-1", "cancellation-ack", 7);

		expect(texts(ledger, { now: 7 })).toEqual([
			"tool start×2 → result",
			"retry rescheduled → dispatched → outcome",
			"cancellation requested → acknowledged",
		]);
	});

	it("does not infer arrows from missing keys, reused keys, text, time, adjacency, or order", () => {
		let ledger = createCausalEvidenceLedger();
		ledger = add(ledger, undefined, "missing-session", "tool-local-start", 0);
		ledger = add(ledger, "session-a", undefined, "tool-local-start", 1);
		ledger = add(ledger, "session-a", "out-of-order", "tool-local-result", 2);
		ledger = add(ledger, "session-a", "out-of-order", "tool-local-start", 3);
		ledger = add(ledger, "session-a", "adjacent-a", "retry-reschedule", 4);
		ledger = add(ledger, "session-a", "adjacent-b", "retry-dispatch", 5);
		ledger = add(ledger, "session-a", "reused", "tool-local-start", 6);
		ledger = add(ledger, "session-a", "reused", "retry-dispatch", 7);

		const rows = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 7 }).topologies;
		expect(rows.map(row => row.text)).toEqual(["tool start ●", "retry rescheduled ●", "tool start ●"]);
		expect(rows.flatMap(row => row.tokens).filter(token => token.role === "edge")).toEqual([]);
	});

	it("namespaces identical opaque relations by session", () => {
		let ledger = createCausalEvidenceLedger();
		ledger = add(ledger, "session-a", "shared", "tool-local-start", 0);
		ledger = add(ledger, "session-b", "shared", "tool-local-result", 1);
		expect(texts(ledger, { now: 1 })).toEqual(["tool start ●"]);

		ledger = add(ledger, "session-a", "shared", "tool-local-result", 2);
		expect(texts(ledger, { now: 2 })).toEqual(["tool start → result"]);
	});

	it("keeps an unacknowledged cancellation in stopping state and never invents timeout success", () => {
		let ledger = createCausalEvidenceLedger({ ttlMs: 100 });
		ledger = add(ledger, "session-a", "cancel", "cancellation-request", 0);

		const waiting = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 99 });
		expect(waiting.topologies).toHaveLength(1);
		expect(waiting.topologies[0]).toMatchObject({
			terminal: false,
			stopping: true,
			text: "cancellation stopping ●",
		});
		expect(JSON.stringify(waiting)).not.toContain("success");
		expect(renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 100 }).topologies).toEqual([]);
	});

	it("evicts the oldest terminal incident before an older active incident", () => {
		let ledger = createCausalEvidenceLedger({ capacity: 3, ttlMs: 1_000 });
		ledger = add(ledger, "s", "active-cancel", "cancellation-request", 0);
		ledger = add(ledger, "s", "terminal-tool", "tool-local-start", 1);
		ledger = add(ledger, "s", "terminal-tool", "tool-local-result", 2);
		ledger = add(ledger, "s", "active-retry", "retry-reschedule", 3);
		ledger = add(ledger, "s", "new-tool", "tool-local-start", 4);

		expect(texts(ledger, { now: 4 })).toEqual(["cancellation stopping ●", "retry rescheduled ●", "tool start ●"]);
	});

	it("expires by caller time without discarding a younger active incident first", () => {
		let ledger = createCausalEvidenceLedger({ capacity: 2, ttlMs: 10 });
		ledger = add(ledger, "s", "terminal", "tool-local-start", 0);
		ledger = add(ledger, "s", "terminal", "tool-local-result", 0);
		ledger = add(ledger, "s", "active", "cancellation-request", 5);

		expect(texts(ledger, { now: 10 })).toEqual(["cancellation stopping ●"]);
		expect(texts(ledger, { now: 15 })).toEqual([]);
	});
});

describe("causal evidence topology projection", () => {
	it("emits deterministic Unicode, ASCII, no-color, reduced, and narrow tokens", () => {
		let ledger = createCausalEvidenceLedger();
		ledger = add(ledger, "s", "retry", "retry-reschedule", 0);
		ledger = add(ledger, "s", "retry", "retry-dispatch", 1);

		expect(texts(ledger, { now: 1 })).toEqual(["retry rescheduled → dispatched ●"]);
		expect(texts(ledger, { now: 1, unicode: false })).toEqual(["retry rescheduled > dispatched o"]);
		expect(texts(ledger, { now: 1, width: 20 })).toEqual(["retry R→D●"]);

		const colored = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 1 });
		const plain = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 1, color: false });
		expect(plain.topologies.map(row => row.text)).toEqual(colored.topologies.map(row => row.text));
		expect(plain.topologies.flatMap(row => row.tokens).every(token => token.tone === undefined)).toBeTrue();

		const reducedA = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 1, phase: 0 });
		const reducedB = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 1, phase: 3 });
		expect(reducedA).toEqual(reducedB);

		const moving = [0, 1, 2, 3].map(
			phase =>
				renderCausalEvidence(ledger, {
					...WIDE_UNICODE,
					now: 1,
					reducedMotion: false,
					phase,
				}).topologies[0]?.text,
		);
		expect(moving).toEqual([
			"retry rescheduled → dispatched ·",
			"retry rescheduled → dispatched •",
			"retry rescheduled → dispatched ●",
			"retry rescheduled → dispatched •",
		]);
		expect(new Set(moving.map(value => value?.length)).size).toBe(1);
	});

	it("marks frame metadata safe without serializing opaque relation keys or private sentinels", () => {
		const session = "PRIVATE_SESSION_SENTINEL";
		const relation = "PRIVATE_RELATION_SENTINEL";
		let ledger = createCausalEvidenceLedger();
		ledger = add(ledger, session, relation, "tool-local-start", 0);
		ledger = add(ledger, session, relation, "tool-local-result", 1);
		const frame = renderCausalEvidence(ledger, { ...WIDE_UNICODE, now: 1 });
		const logged = JSON.stringify({ ledger, frame });

		expect(frame.safeForFrameLint).toBeTrue();
		expect(logged).not.toContain(session);
		expect(logged).not.toContain(relation);
		expect(logged).not.toContain("causal-evidence-incidents");
		expect(Object.keys(frame)).toEqual(["safeForFrameLint", "topologies"]);
	});
});
