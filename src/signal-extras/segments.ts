import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SegmentSample } from "../animations-box/segments";
import type { PhraseSpan, StatusDot } from "../animations-box/status-line";
import type { LiveFileSnapshot } from "../live-files";
import type { SignalExtraId, SignalExtrasConfig } from "./settings";
import type { SignalExtrasSnapshot } from "./state";

const ORDER: readonly SignalExtraId[] = [
	"recurrenceStrip",
	"contextRewriteShadow",
	"compactionScar",
	"consentLock",
	"sessionPhylogeny",
	"thinkActLissajous",
	"errorIsotope",
	"queueFog",
	"skillChromatograph",
	"retryRadar",
	"goalHeading",
	"ttftSplit",
	"memoryBackendTide",
];

const RETRY_RING = ["○", "◔", "◑", "◕", "●"] as const;

function compactNumber(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function sample(
	id: SignalExtraId,
	dot: StatusDot,
	label: string,
	accent: ThemeColor,
	spans: readonly PhraseSpan[],
	variants?: readonly string[],
): SegmentSample {
	const phrase = spans.map((span, index) => `${index === 0 ? "" : (span.sep ?? " · ")}${span.text}`).join("");
	return {
		id,
		priority: ORDER.indexOf(id) + 1,
		active: true,
		variants: variants ?? [phrase],
		line: { dot, label, accent, spans },
	};
}

function retryFrame(now: number, startedAt: number, delayMs: number): string {
	if (delayMs <= 0) return RETRY_RING.at(-1) ?? "●";
	const ratio = Math.max(0, Math.min(1, 1 - (now - startedAt) / delayMs));
	return RETRY_RING[Math.round(ratio * (RETRY_RING.length - 1))] ?? "○";
}

/** Enabled, meaningful sidecar rows only. An empty result is the zero-height idle contract. */
export function buildSignalExtraSegments(
	state: SignalExtrasSnapshot,
	config: SignalExtrasConfig,
	now: number,
): readonly SegmentSample[] {
	const rows: SegmentSample[] = [];
	const add = (id: SignalExtraId, row: SegmentSample | undefined): void => {
		if (config[id] && row !== undefined) rows.push(row);
	};

	const recurrence = state.recurrence;
	add(
		"recurrenceStrip",
		recurrence === undefined
			? undefined
			: sample("recurrenceStrip", recurrence.orbit ? "alert" : "notable", "loop", "syntaxKeyword", [
					{ key: "cells", text: recurrence.cells.map(orbit => (orbit ? "▓" : "░")).join("") },
					{
						key: "mode",
						text: recurrence.orbit ? "orbit" : "heading",
						tone: recurrence.orbit ? "alert" : undefined,
					},
				]),
	);

	const rewrite = state.rewrite;
	add(
		"contextRewriteShadow",
		rewrite === undefined
			? undefined
			: sample("contextRewriteShadow", "notable", "rewrite", "syntaxKeyword", [
					{ key: "shown", text: `shown ${compactNumber(rewrite.shown)}` },
					{ key: "sent", text: `sent ${compactNumber(rewrite.sent)}` },
					{
						key: "stripped",
						text: `stripped ${compactNumber(rewrite.stripped)}`,
						tone: rewrite.stripped > 0 ? "notable" : undefined,
					},
				]),
	);

	const scar = state.scar;
	add(
		"compactionScar",
		scar === undefined
			? undefined
			: sample("compactionScar", scar.rereadCount > 0 ? "notable" : "live", "scar", "syntaxNumber", [
					{ key: "cut", text: `${compactNumber(scar.cutTokens)} cut` },
					{
						key: "reread",
						text: `re-read ${scar.rereadCount}`,
						tone: scar.rereadCount > 0 ? "notable" : undefined,
					},
				]),
	);

	const consent = state.consent;
	add(
		"consentLock",
		consent === undefined
			? undefined
			: sample("consentLock", "alert", "consent", "error", [
					{ key: "tool", text: consent.tool, tone: "alert" },
					{ key: "wait", text: consent.reason ?? "waiting on you", tone: "alert" },
				]),
	);

	const tree = state.phylogeny;
	add(
		"sessionPhylogeny",
		tree === undefined
			? undefined
			: sample("sessionPhylogeny", "notable", "tree", "syntaxType", [
					{ key: "depth", text: `depth ${tree.depth}` },
					{ key: "siblings", text: `${tree.siblings} siblings` },
					{ key: "node", text: tree.node },
				]),
	);

	const thinkAct = state.thinkAct;
	if (thinkAct !== undefined) {
		const shape = thinkAct.shape === "thinking" ? "│" : thinkAct.shape === "acting" ? "─" : "◜◝";
		add(
			"thinkActLissajous",
			sample("thinkActLissajous", thinkAct.shape === "thinking" ? "notable" : "live", "think", "syntaxFunction", [
				{ key: "shape", text: shape },
				{ key: "thinking", text: `think ${compactNumber(thinkAct.thinkingTokens)}` },
				{ key: "acting", text: `act ${compactNumber(thinkAct.actingTokens)}` },
			]),
		);
	}

	const error = state.error;
	add(
		"errorIsotope",
		error === undefined
			? undefined
			: sample("errorIsotope", "alert", "error", "error", [
					{ key: "signature", text: error.signature, tone: "alert" },
					{ key: "count", text: `×${error.count}`, tone: "alert" },
				]),
	);

	add(
		"queueFog",
		state.queuePending
			? sample("queueFog", "notable", "queue", "warning", [
					{ key: "pending", text: "follow-up queued", tone: "notable" },
				])
			: undefined,
	);

	add(
		"skillChromatograph",
		state.skills.length === 0
			? undefined
			: sample("skillChromatograph", "live", "skills", "success", [
					{ key: "skills", text: state.skills.map(name => `▌${name}`).join(" ") },
					{ key: "scope", text: "this turn", tone: "dim" },
				]),
	);

	const retry = state.retry;
	add(
		"retryRadar",
		retry === undefined
			? undefined
			: sample("retryRadar", "notable", "retry", "warning", [
					{ key: "radar", text: retryFrame(now, retry.startedAt, retry.delayMs) },
					{ key: "attempt", text: `${retry.attempt}/${retry.maxAttempts}` },
					{ key: "error", text: retry.error, tone: "notable" },
					...(retry.fallback === undefined ? [] : [{ key: "fallback", text: `→ ${retry.fallback}` }]),
				]),
	);

	const goal = state.goal;
	if (goal !== undefined) {
		const progress = goal.tokenBudget === undefined ? undefined : goal.tokensUsed / Math.max(1, goal.tokenBudget);
		add(
			"goalHeading",
			sample("goalHeading", goal.status === "active" ? "live" : "notable", "heading", "success", [
				{ key: "direction", text: goal.status === "active" ? "→" : "↻" },
				{ key: "objective", text: goal.objective },
				...(progress === undefined
					? [{ key: "status", text: goal.status }]
					: [
							{
								key: "progress",
								text: `${Math.round(progress * 100)}%`,
								gradient: { ratio: progress, direction: "down-good" as const },
							},
						]),
			]),
		);
	}

	const ttft = state.ttftMs;
	add(
		"ttftSplit",
		ttft === undefined
			? undefined
			: sample("ttftSplit", ttft >= 3_000 ? "alert" : ttft >= 1_500 ? "notable" : "live", "ttft", "syntaxNumber", [
					{
						key: "latency",
						text: `first token ${(ttft / 1_000).toFixed(1)}s`,
						tone: ttft >= 3_000 ? "alert" : ttft >= 1_500 ? "notable" : undefined,
					},
				]),
	);

	const memory = state.memory;
	add(
		"memoryBackendTide",
		memory === undefined
			? undefined
			: sample("memoryBackendTide", "live", "memory", "syntaxKeyword", [
					{ key: "writes", text: `${memory.writes} write` },
					{
						key: "recall",
						text: memory.recalled ? "recall" : "no recall",
						tone: memory.recalled ? undefined : "dim",
					},
					{ key: "backend", text: `backend:${memory.backend}` },
				]),
	);

	return rows;
}

/** Terminal-title projection of the same facts; no extra state and no screen height. */
export function buildDarkroomTitle(
	state: SignalExtrasSnapshot,
	contextPercent: number | undefined,
	files: LiveFileSnapshot,
): string {
	const fields = ["omp"];
	if (state.consent !== undefined) fields.push("WAIT", state.consent.tool);
	else if (state.retry !== undefined) fields.push("retry", `${state.retry.attempt}/${state.retry.maxAttempts}`);
	if (contextPercent !== undefined) fields.push("ctx", String(Math.round(contextPercent)));
	if (files.entries.length === 1) fields.push("1 writer");
	else if (files.entries.length > 1) fields.push(`${files.entries.length} writers`);
	if (state.recurrence?.orbit) fields.push("LOOP");
	if (state.scar !== undefined) fields.push("SCAR", `re-read ${state.scar.rereadCount}`);
	if (state.thinkAct?.shape === "thinking") fields.push("THINK", compactNumber(state.thinkAct.thinkingTokens));
	if ((state.memory?.writes ?? 0) > 0) fields.push("mem", `${state.memory?.writes ?? 0}w`);
	return fields
		.join("  ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.slice(0, 96);
}
