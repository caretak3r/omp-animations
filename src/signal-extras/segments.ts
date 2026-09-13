import type { ActivityRosterSnapshot } from "../activity-roster/bus";
import type { SegmentSample } from "../animations-box/segments";
import type { PhraseSpan, StatusDot } from "../animations-box/status-line";
import type {
	TemporalEvidenceKind,
	TemporalEvidenceSnapshot,
	TemporalEvidenceStage,
} from "../animations-box/temporal-evidence";
import { ageText } from "../duration";
import type { AsyncJobSnapshot, ThemeColor } from "../host/types";
import type { LiveFileSnapshot } from "../live-files";
import { retryFuse } from "./lifecycle-effects";
import { renderMemoryTide } from "./memory-tide";
import { quantizeDurationSamples } from "./metric-effects";
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
	"skillChromatograph",
	"retryRadar",
	"verify",
	"authBeacon",
	"asyncJobHarbor",
	"goalHeading",
	"ttftSplit",
	"memoryBackendTide",
];

const METRIC_TICKS = ["·", "▁", "▂", "▃", "▄"] as const;
const REPEAT_GLOW_MS = 1_200;

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
	activity = false,
): SegmentSample {
	const phrase = spans.map((span, index) => `${index === 0 ? "" : (span.sep ?? " · ")}${span.text}`).join("");
	return {
		id,
		priority: ORDER.indexOf(id) + 1,
		active: true,
		variants: variants ?? [phrase],
		line: { dot, label, accent, spans, activity },
	};
}

function evidenceStage(
	snapshot: TemporalEvidenceSnapshot,
	kind: TemporalEvidenceKind,
	slot?: number,
): TemporalEvidenceStage | undefined {
	let latest: { readonly observedAt: number; readonly stage: TemporalEvidenceStage } | undefined;
	for (const entry of snapshot.entries) {
		if (entry.kind !== kind || (slot !== undefined && entry.slot !== slot)) continue;
		if (latest === undefined || entry.observedAt > latest.observedAt) latest = entry;
	}
	return latest?.stage;
}

function timingHistoryText(samples: Parameters<typeof quantizeDurationSamples>[0]): string | undefined {
	const quantized = quantizeDurationSamples(samples);
	if (quantized === undefined) return undefined;
	return `${quantized.levels.map(level => METRIC_TICKS[level] ?? "·").join("")} ${quantized.comparison}`;
}

/**
 * Async Job Harbor row. `delivery.pendingJobIds` names the exact jobs still
 * queued for an `async-result` delivery message; cross-referencing each ID
 * against the retained `recent` window tells us its real outcome. A pending
 * ID absent from that window fell outside the retained history — its
 * outcome is genuinely unknown, not assumed, so it is counted separately
 * rather than folded into "ready". "Recent failed"/"recent cancelled" are
 * reported independent of delivery status: a failure stays worth surfacing
 * even after its result has already reached the transcript.
 */
function buildAsyncJobHarborSample(
	snapshot: AsyncJobSnapshot | null | undefined,
	now: number,
): SegmentSample | undefined {
	if (snapshot === null || snapshot === undefined) return undefined;
	const { running, recent, delivery } = snapshot;
	const recentById = new Map(recent.map(job => [job.id, job] as const));
	let ready = 0;
	let unknown = 0;
	for (const id of delivery.pendingJobIds) {
		const job = recentById.get(id);
		if (job === undefined) unknown++;
		else if (job.status === "completed") ready++;
	}
	const failed = recent.filter(job => job.status === "failed");
	const cancelled = recent.filter(job => job.status === "cancelled");
	const nothingToShow =
		running.length === 0 && ready === 0 && unknown === 0 && failed.length === 0 && cancelled.length === 0;
	if (nothingToShow) return undefined;

	const spans: PhraseSpan[] = [];
	if (running.length > 0) {
		spans.push({ key: "running", text: `${running.length} running`, tone: "notable" });
		const finiteStartTimes = running.map(job => job.startTime).filter(t => Number.isFinite(t));
		if (finiteStartTimes.length > 0) {
			const oldest = Math.min(...finiteStartTimes);
			const age = Math.max(0, now - oldest);
			spans.push({ key: "oldest", text: `oldest ${ageText(age)}`, tone: "dim", wideOnly: true });
		}
	}
	if (ready > 0) spans.push({ key: "ready", text: `${ready} ready` });
	if (failed.length > 0) spans.push({ key: "failed", text: `${failed.length} failed`, tone: "alert" });
	if (cancelled.length > 0) spans.push({ key: "cancelled", text: `${cancelled.length} cancelled`, tone: "notable" });
	if (unknown > 0) spans.push({ key: "unknown", text: `${unknown} unknown`, tone: "dim", wideOnly: true });
	const latest = recent[0];
	if (latest !== undefined && (latest.status === "failed" || latest.status === "cancelled")) {
		spans.push({
			key: "last",
			text: `last ${latest.label ?? latest.type} ${latest.status}`,
			tone: "dim",
			wideOnly: true,
		});
	}

	const dot: StatusDot =
		failed.length > 0 ? "alert" : running.length > 0 || ready > 0 || unknown > 0 ? "notable" : "live";
	const accent: ThemeColor = failed.length > 0 ? "error" : "syntaxKeyword";
	return sample("asyncJobHarbor", dot, "jobs", accent, spans);
}

interface ResourceOutcomes {
	complete: number;
	active: number;
	error: number;
}

interface ReadSkillCount extends ResourceOutcomes {
	readonly name: string;
}

interface ExactSkillUsage {
	readonly skills: readonly ReadSkillCount[];
	readonly outcomes: ResourceOutcomes;
}

interface RecentUsage {
	readonly label: string;
	readonly startedAt: number;
}

interface ExactResourceUsage {
	readonly spans: readonly PhraseSpan[];
	readonly active: boolean;
	readonly failed: boolean;
}

function exactSkillUsage(roster: ActivityRosterSnapshot | undefined): ExactSkillUsage | undefined {
	if (roster === undefined) return undefined;

	const events = roster.agents.flatMap((agent, agentIndex) =>
		agent.provenance
			.filter(provenance => provenance.kind === "skill")
			.map(provenance => ({ provenance, agentIndex })),
	);
	events.sort(
		(left, right) =>
			left.provenance.startedAt - right.provenance.startedAt ||
			left.agentIndex - right.agentIndex ||
			left.provenance.id.localeCompare(right.provenance.id),
	);

	const skills: ReadSkillCount[] = [];
	const counts = new Map<string, ReadSkillCount>();
	const outcomes: ResourceOutcomes = { complete: 0, active: 0, error: 0 };
	for (const { provenance } of events) {
		let skill = counts.get(provenance.label);
		if (skill === undefined) {
			skill = { name: provenance.label, complete: 0, active: 0, error: 0 };
			counts.set(provenance.label, skill);
			skills.push(skill);
		}
		skill[provenance.status]++;
		outcomes[provenance.status]++;
	}
	return skills.length === 0 ? undefined : { skills, outcomes };
}

function outcomeText(outcomes: ResourceOutcomes, completeLabel: string | undefined, countMark: "×" | "x"): string {
	const parts: string[] = [];
	if (outcomes.error > 0) parts.push(`failed ${countMark}${outcomes.error}`);
	if (outcomes.active > 0) parts.push(`active ${countMark}${outcomes.active}`);
	if (completeLabel !== undefined && outcomes.complete > 0)
		parts.push(`${completeLabel} ${countMark}${outcomes.complete}`);
	return parts.join(" · ");
}

function laterUsage(current: RecentUsage | undefined, label: string, startedAt: number): RecentUsage {
	return current === undefined || startedAt >= current.startedAt ? { label, startedAt } : current;
}

function qmdOperationLabel(label: string): string {
	return label.startsWith("QMD ") ? label.slice(4).toLowerCase() : label.toLowerCase();
}

function contextFileLabel(label: string): string {
	return label.split(/[\\/]/u).at(-1) ?? label;
}

function exactResourceUsage(
	roster: ActivityRosterSnapshot | undefined,
	countMark: "×" | "x",
): ExactResourceUsage | undefined {
	if (roster === undefined) return undefined;
	const outcomes = {
		memory: { complete: 0, active: 0, error: 0 },
		"context-file": { complete: 0, active: 0, error: 0 },
		qmd: { complete: 0, active: 0, error: 0 },
	};

	let failed = false;
	let memoryRecalls = 0;
	let memoryWrites = 0;
	let memoryOther = 0;
	let contextSourceLabel: string | undefined;
	let contextLabel: string | undefined;
	let contextLabelVaries = false;
	let latestContext: RecentUsage | undefined;
	let qmdLabel: string | undefined;
	let qmdLabelVaries = false;
	let latestQmd: RecentUsage | undefined;
	let active = false;

	for (const agent of roster.agents) {
		for (const provenance of agent.provenance) {
			if (provenance.kind === "skill") continue;
			outcomes[provenance.kind][provenance.status]++;
			if (provenance.status === "active") active = true;
			if (provenance.status === "error") failed = true;
			if (provenance.status !== "complete") continue;
			if (provenance.kind === "memory") {
				switch (provenance.label) {
					case "read":
					case "recall":
					case "reflect":
						memoryRecalls++;
						break;
					case "retain":
					case "learn":
					case "memory edit":
						memoryWrites++;
						break;
					default:
						memoryOther++;
				}
				continue;
			}
			if (provenance.kind === "context-file") {
				const label = contextFileLabel(provenance.label);
				if (contextSourceLabel === undefined) {
					contextSourceLabel = provenance.label;
					contextLabel = label;
				} else if (contextSourceLabel !== provenance.label) contextLabelVaries = true;
				latestContext = laterUsage(latestContext, label, provenance.startedAt);
				continue;
			}
			if (qmdLabel === undefined) qmdLabel = provenance.label;
			else if (qmdLabel !== provenance.label) qmdLabelVaries = true;
			latestQmd = laterUsage(latestQmd, provenance.label, provenance.startedAt);
		}
	}

	const spans: PhraseSpan[] = [];
	if (outcomes.memory.complete > 0) {
		if (memoryRecalls > 0) {
			spans.push({ key: "memory-recalls", text: `recent recall complete ${countMark}${memoryRecalls}` });
		}
		if (memoryWrites > 0) {
			spans.push({ key: "memory-writes", text: `recent writes complete ${countMark}${memoryWrites}` });
		}
		if (memoryOther > 0) {
			spans.push({ key: "memory-operations", text: `recent memory complete ${countMark}${memoryOther}` });
		}
	}
	if (outcomes["context-file"].complete > 0) {
		if (!contextLabelVaries && contextLabel !== undefined) {
			spans.push({
				key: "context-reads",
				text: `recent context ${contextLabel} read ${countMark}${outcomes["context-file"].complete}`,
			});
		} else {
			spans.push({
				key: "context-reads",
				text: `recent context read ${countMark}${outcomes["context-file"].complete}`,
			});
			if (latestContext !== undefined) {
				spans.push({
					key: "context-latest",
					text: `last read ${latestContext.label}`,
					tone: "dim",
					wideOnly: true,
				});
			}
		}
	}
	if (outcomes.qmd.complete > 0) {
		if (!qmdLabelVaries && qmdLabel !== undefined) {
			spans.push({
				key: "qmd-operations",
				text: `recent qmd ${qmdOperationLabel(qmdLabel)} complete ${countMark}${outcomes.qmd.complete}`,
			});
		} else {
			spans.push({ key: "qmd-operations", text: `recent qmd complete ${countMark}${outcomes.qmd.complete}` });
			if (latestQmd !== undefined) {
				spans.push({
					key: "qmd-latest",
					text: `last completed ${qmdOperationLabel(latestQmd.label)}`,
					tone: "dim",
					wideOnly: true,
				});
			}
		}
	}
	for (const kind of ["memory", "context-file", "qmd"] as const) {
		const pending = outcomes[kind];
		if (pending.active === 0 && pending.error === 0) continue;
		const label = kind === "context-file" ? "context" : kind;
		spans.unshift({
			key: `${kind}-attempts`,
			text: `recent ${label} ${outcomeText(pending, undefined, countMark)}`,
			tone: pending.error > 0 ? "alert" : "notable",
			priority: pending.error > 0 ? -2 : -1,
		});
	}
	return spans.length === 0 ? undefined : { spans, active, failed };
}

function phraseText(spans: readonly PhraseSpan[]): string {
	return spans.map((span, index) => `${index === 0 ? "" : (span.sep ?? " · ")}${span.text}`).join("");
}

function uniqueVariants(candidates: readonly string[]): readonly string[] {
	const variants: string[] = [];
	for (const candidate of candidates) if (variants.at(-1) !== candidate) variants.push(candidate);
	return variants;
}

/** Enabled, meaningful sidecar rows only. An empty result is the zero-height idle contract. */
export function buildSignalExtraSegments(
	state: SignalExtrasSnapshot,
	config: SignalExtrasConfig,
	now: number,
	evidence: TemporalEvidenceSnapshot,
	capabilities: { readonly unicode: boolean; readonly reducedMotion: boolean },
	roster?: ActivityRosterSnapshot,
	asyncJobSnapshot?: AsyncJobSnapshot | null,
): readonly SegmentSample[] {
	const rows: SegmentSample[] = [];
	const add = (id: SignalExtraId, row: SegmentSample | undefined): void => {
		if (config[id] && row !== undefined) rows.push(row);
	};

	const recurrence = state.recurrence;
	const repeatGlow =
		recurrence !== undefined &&
		now >= recurrence.observedAt &&
		now - recurrence.observedAt < REPEAT_GLOW_MS &&
		!capabilities.reducedMotion;
	add(
		"recurrenceStrip",
		recurrence === undefined
			? undefined
			: sample(
					"recurrenceStrip",
					"notable",
					"repeat",
					"syntaxKeyword",
					[
						{
							key: "meaning",
							text:
								recurrence.turns === 2
									? "same tools as previous turn"
									: `same tools for ${recurrence.turns} turns`,
						},
					],
					undefined,
					repeatGlow,
				),
	);

	const rewrite = state.rewrite;
	add(
		"contextRewriteShadow",
		rewrite === undefined
			? undefined
			: sample("contextRewriteShadow", "notable", "rewrite", "syntaxKeyword", [
					{
						key: "stripped",
						text: `stripped ~${compactNumber(rewrite.stripped)}`,
						tone: "notable",
					},
					{ key: "shown", text: `shown ~${compactNumber(rewrite.shown)}` },
					{
						key: "sent",
						text: `sent ${rewrite.sentIsActual ? "" : "~"}${compactNumber(rewrite.sent)}`,
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
						text: `${scar.rereadCount} reads since compact`,
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
					{ key: "wait", text: "waiting on you", tone: "alert" },
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
					...(tree.offPathCostUsd !== undefined && tree.offPathCostUsd >= 0.005
						? [{ key: "off-path", text: `off-path $${tree.offPathCostUsd.toFixed(2)}` }]
						: []),
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
	const errorSpans: PhraseSpan[] = [];
	if (error !== undefined) {
		if (error.truncated !== undefined && error.truncated > 0) {
			errorSpans.push({ key: "truncated", text: `trunc ×${error.truncated}`, tone: "alert" });
		}
		if (error.droppedFeatures !== undefined && error.droppedFeatures.length > 0) {
			const joined = error.droppedFeatures.join(",");
			const clamped = joined.length > 24 ? joined.slice(0, 24) : joined;
			errorSpans.push({ key: "dropped", text: `dropped ${clamped}`, tone: "alert" });
		}
		if (error.count >= 2) {
			errorSpans.push({ key: "tool-failures", text: "tool failures", tone: "alert" });
			errorSpans.push({ key: "count", text: `×${error.count}`, tone: "alert" });
		}
		if (error.reroutedTo !== undefined) {
			errorSpans.push({ key: "rerouted", text: `via ${error.reroutedTo}`, tone: "dim" });
		}
	}
	const hasAlertSpan = errorSpans.some(span => span.tone === "alert");
	add(
		"errorIsotope",
		errorSpans.length === 0
			? undefined
			: sample("errorIsotope", hasAlertSpan ? "alert" : "notable", "error", "error", errorSpans),
	);

	const skillUsage = exactSkillUsage(roster);
	const countMark = capabilities.unicode ? "×" : "x";
	const skillSpans: PhraseSpan[] | undefined = skillUsage?.skills.map(skill => ({
		key: `read-${skill.name}`,
		text: `recent ${outcomeText(skill, "read", countMark)} ${skill.name}`,
		tone: skill.error > 0 ? "alert" : skill.active > 0 ? "notable" : undefined,
		priority: skill.error > 0 ? -2 : skill.active > 0 ? -1 : 0,
	}));
	const availableSkills = roster?.resourceCatalog.availableSkills.length ?? 0;
	if (skillSpans !== undefined && availableSkills > 0) {
		skillSpans.push({
			key: "available",
			text: `available ${countMark}${availableSkills}`,
			tone: "dim",
			wideOnly: true,
		});
	}
	const skillPhrase = skillSpans?.map(span => span.text).join(" · ");
	add(
		"skillChromatograph",
		skillUsage === undefined || skillSpans === undefined || skillPhrase === undefined
			? undefined
			: sample(
					"skillChromatograph",
					skillUsage.outcomes.error > 0 ? "alert" : skillUsage.outcomes.active > 0 ? "notable" : "live",
					"skills",
					skillUsage.outcomes.error > 0 ? "error" : "success",
					skillSpans,
					uniqueVariants([
						`skills ${skillPhrase}`,
						`skills recent ${outcomeText(skillUsage.outcomes, "read", countMark)}`,
					]),
					skillUsage.outcomes.active > 0,
				),
	);

	const retry = retryFuse(state.retry, now, {
		width: 40,
		unicode: capabilities.unicode,
		reducedMotion: capabilities.reducedMotion,
	});
	const fallback = state.retryFallback;
	const radarSpans: PhraseSpan[] = [];
	if (retry !== undefined) {
		radarSpans.push({ key: "fuse", text: retry.text.trimEnd(), tone: "notable" });
	}
	if (fallback !== undefined) {
		const clampModel = (model: string) => (model.length > 20 ? model.slice(0, 20) : model);
		const from = clampModel(fallback.from);
		const to = clampModel(fallback.to);
		radarSpans.push({
			key: "fallback",
			text: `fallback ${from}→${to}`,
			tone: fallback.succeeded ? "value" : "notable",
		});
	}
	add(
		"retryRadar",
		radarSpans.length === 0 ? undefined : sample("retryRadar", "notable", "retry", "warning", radarSpans),
	);

	const unverifiedWrites = state.unverifiedWrites;
	add(
		"verify",
		unverifiedWrites === 0
			? undefined
			: sample("verify", "notable", "verify", "warning", [
					{
						key: "count",
						text: `${unverifiedWrites} write${unverifiedWrites === 1 ? "" : "s"} since green bash`,
						tone: "notable",
					},
				]),
	);

	const credentialAlerts = state.credentialAlerts;
	add(
		"authBeacon",
		credentialAlerts.length === 0
			? undefined
			: sample(
					"authBeacon",
					"alert",
					"auth",
					"error",
					credentialAlerts.map(provider => ({
						key: `provider-${provider}`,
						text: `${provider} credential disabled`,
						tone: "alert" as const,
					})),
				),
	);

	add("asyncJobHarbor", buildAsyncJobHarborSample(asyncJobSnapshot, now));

	const goal = state.goal;
	if (goal !== undefined) {
		const progress =
			goal.tokenBudget === undefined ? undefined : Math.min(1, goal.tokensUsed / Math.max(1, goal.tokenBudget));
		add(
			"goalHeading",
			sample("goalHeading", goal.status === "active" ? "live" : "notable", "heading", "success", [
				{ key: "direction", text: goal.status === "active" ? "→" : "↻" },
				{ key: "goal", text: "goal" },
				{ key: "status", text: goal.status },
				...(progress === undefined
					? []
					: [
							{
								key: "progress",
								text: `budget ${Math.round(progress * 100)}%`,
								gradient: { ratio: progress, direction: "down-good" as const },
							},
						]),
			]),
		);
	}

	const timing = state.assistantTiming;
	if (timing !== undefined) {
		const ttftHistory = timingHistoryText(state.ttftHistory);
		const durationHistory = timingHistoryText(state.durationHistory);
		const timingStage = evidenceStage(evidence, "latency-sample", 1) ?? evidenceStage(evidence, "latency-sample", 0);
		add(
			"ttftSplit",
			sample("ttftSplit", "live", "timing", "syntaxNumber", [
				...(timing.ttftMs === undefined
					? []
					: [{ key: "ttft", text: `ttft ${(timing.ttftMs / 1_000).toFixed(1)}s` }]),
				...(timing.durationMs === undefined
					? []
					: [{ key: "duration", text: `total ${(timing.durationMs / 1_000).toFixed(1)}s` }]),
				...(ttftHistory === undefined
					? []
					: [{ key: "ttft-history", text: `ttft ${ttftHistory}`, tone: "dim" as const }]),
				...(durationHistory === undefined
					? []
					: [{ key: "duration-history", text: `total ${durationHistory}`, tone: "dim" as const }]),
				...(timingStage === undefined ? [] : [{ key: "freshness", text: timingStage, tone: "dim" as const }]),
			]),
		);
	}

	const usage = exactResourceUsage(roster, countMark);
	const memoryStage = evidenceStage(evidence, "memory-observation", 0);
	const memoryTokens = renderMemoryTide(state.memoryTide, {
		now,
		width: 160,
		height: 1,
		mode: "compact",
		symbols: capabilities.unicode ? "unicode" : "ascii",
		stage: memoryStage,
	})[0]?.tokens.filter(token => token.semantic !== "label");
	const readiness = memoryTokens?.[0];
	const readinessSpans: readonly PhraseSpan[] =
		memoryTokens?.map((token, index) => ({
			key: `${token.semantic}-${index}`,
			text: token.text,
			priority: 0,
			tone:
				token.tone === "negative"
					? ("alert" as const)
					: token.tone === "warning"
						? ("notable" as const)
						: token.tone === "muted"
							? ("dim" as const)
							: undefined,
		})) ?? [];
	const memorySpans = [...readinessSpans, ...(usage?.spans ?? [])];
	const readinessQuiet = readiness === undefined || readiness.tone === "muted";
	const showMemory = memorySpans.length > 0 && (!readinessQuiet || usage !== undefined);
	const memoryPhrase = phraseText(memorySpans);
	const coreMemoryPhrase = phraseText(memorySpans.filter(span => span.wideOnly !== true));
	const narrowMemory =
		usage?.spans.find(span => span.tone === "alert")?.text ??
		usage?.spans.find(span => span.tone === "notable")?.text ??
		readiness?.text ??
		usage?.spans[0]?.text ??
		"";
	add(
		"memoryBackendTide",
		!showMemory
			? undefined
			: sample(
					"memoryBackendTide",
					usage?.failed
						? "alert"
						: readiness?.tone === "negative" || readiness?.tone === "warning"
							? "notable"
							: "live",
					"memory",
					"syntaxKeyword",
					memorySpans,
					uniqueVariants([`memory ${memoryPhrase}`, `memory ${coreMemoryPhrase}`, `memory ${narrowMemory}`]),
					usage?.active ?? false,
				),
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
	else if (state.retry !== undefined) {
		fields.push(
			"retry",
			state.retry.maxAttempts === undefined
				? String(state.retry.attempt)
				: `${state.retry.attempt}/${state.retry.maxAttempts}`,
		);
	}
	if (contextPercent !== undefined) fields.push("ctx", String(Math.round(contextPercent)));
	if (files.entries.length === 1) fields.push("1 writer");
	else if (files.entries.length > 1) fields.push(`${files.entries.length} writers`);
	if (state.recurrence !== undefined) fields.push("REPEAT");
	if (state.scar !== undefined) fields.push("SCAR", `re-read ${state.scar.rereadCount}`);
	if (state.thinkAct?.shape === "thinking") fields.push("THINK", compactNumber(state.thinkAct.thinkingTokens));
	return fields
		.join("  ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.slice(0, 96);
}
