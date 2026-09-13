import { Ellipsis, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
	activityPulsePhase,
	type FlashTier,
	type FlashTracker,
	FULL_FLASH_MS,
	type PhraseSpan,
	SUBTLE_FLASH_MS,
} from "../animations-box/status-line";
import type { GlyphKey } from "../glyph-presets";
import { resolveGlyph } from "../glyph-presets";
import type { SymbolPreset, Theme, ThemeColor } from "../host/types";
import { hyperlinksSupported, osc8Hyperlink } from "./hyperlinks";
import type {
	AgentActivityStep,
	AgentBonsaiNode,
	AgentBonsaiSnapshot,
	AgentBonsaiStatus,
	AgentProvenanceEvent,
} from "./state";

export type AgentBonsaiTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold" | "symbol">>;

const STATUS_GLYPHS: Readonly<Record<AgentBonsaiStatus, GlyphKey>> = {
	pending: "box.dot.idle",
	running: "box.dot.live",
	idle: "box.dot.idle",
	completed: "box.dot.idle",
	parked: "box.dot.notable",
	aborted: "box.dot.alert",
};

const STATUS_COLORS: Readonly<Record<AgentBonsaiStatus, ThemeColor>> = {
	pending: "dim",
	running: "syntaxFunction",
	idle: "dim",
	completed: "success",
	parked: "warning",
	aborted: "error",
};

const SPAWN_FRAME_MS = 180;
const SPAWN_GLYPHS = ["○", "◐", "●"] as const;
const ASCII_SPAWN_GLYPHS = ["o", "*", "*"] as const;
const ACTIVITY_KIND_LABELS: Readonly<Record<AgentActivityStep["kind"], string>> = {
	tool: "T",
	skill: "S",
	file: "F",
};
const PROVENANCE_KIND_LABELS: Readonly<Record<AgentProvenanceEvent["kind"], string>> = {
	skill: "S",
	"context-file": "C",
	memory: "M",
	qmd: "Q",
};

const ACTIVITY_STATUS_GLYPHS: Readonly<
	Record<AgentActivityStep["status"], Readonly<Record<"unicode" | "ascii", string>>>
> = {
	active: { unicode: "●", ascii: "*" },
	complete: { unicode: "✓", ascii: "+" },
	error: { unicode: "×", ascii: "!" },
};

interface AgentBonsaiRowSpans {
	readonly status: PhraseSpan;
	readonly name: PhraseSpan;
	readonly model: PhraseSpan;
	readonly skill: PhraseSpan;
	readonly gist: PhraseSpan;
	readonly task: PhraseSpan;
	readonly collision: PhraseSpan;
}

export interface AgentBonsaiRenderContext {
	readonly theme: AgentBonsaiTheme;
	readonly glyphPreset: SymbolPreset;
	readonly now: number;
	readonly flashTier: FlashTier;
	readonly flash?: FlashTracker;
	readonly seenIds?: Set<string>;
	/**
	 * Emit OSC 8 hyperlinks for the active-skill chip. Defaults to {@link hyperlinksSupported} —
	 * the plugin-local capability gate, since the host's own gate is inert from a plugin.
	 */
	readonly hyperlinks?: boolean;
}

function modelLabel(node: AgentBonsaiNode): string {
	if (node.model !== undefined) return node.model;
	return node.status === "parked" ? "(parked)" : "";
}

function skillLabel(node: AgentBonsaiNode): string {
	const active = node.activeSkill;
	return active === undefined ? "" : `seen-skill:${active.name}`;
}

/** Data URI opened by the observed-skill link; keeps disclosure local to the terminal host. */
export function buildSkillDisclosureUri(node: AgentBonsaiNode): string | undefined {
	const active = node.activeSkill;
	if (active === undefined) return undefined;
	const loaded = node.loadedSkills.length > 0 ? node.loadedSkills : [active];
	const text = [
		`Agent Bonsai · ${node.cohortLabel} ${node.name}`,
		`Last observed skill reference (inferred): ${active.name}`,
		`Observed skill references (${loaded.length}):`,
		...loaded.map(skill => `- ${skill.name} — ${skill.path}`),
	].join("\n");
	return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function gistLabel(node: AgentBonsaiNode): string {
	if (node.gist !== undefined) return node.gist;
	if (node.status === "completed") return "(completed)";
	if (node.status === "pending") return "(pending)";
	if (node.status === "parked") return "(parked)";
	if (node.status === "aborted") return "(aborted)";
	return "";
}

function rowSpans(node: AgentBonsaiNode): AgentBonsaiRowSpans {
	return {
		status: { key: "status", text: node.status },
		name: { key: "name", text: `${node.cohortLabel} ${node.name}` },
		model: { key: "model", text: modelLabel(node) },
		skill: { key: "skill", text: skillLabel(node) },
		gist: { key: "gist", text: gistLabel(node) },
		task: { key: "task", text: node.task ?? "" },
		collision: { key: "collision", text: node.collision ? "write-clash" : "" },
	};
}

function observeRows(snapshot: AgentBonsaiSnapshot, ctx: AgentBonsaiRenderContext): Map<string, AgentBonsaiRowSpans> {
	const currentIds = new Set(snapshot.nodes.map(node => node.id));
	if (ctx.seenIds !== undefined) {
		for (const id of ctx.seenIds) if (!currentIds.has(id)) ctx.seenIds.delete(id);
	}
	const spansById = new Map<string, AgentBonsaiRowSpans>();
	for (const node of snapshot.nodes) {
		const spans = rowSpans(node);
		const list = [spans.name, spans.model, spans.skill, spans.gist, spans.task, spans.collision];
		if (node.completedAt === undefined) list.push(spans.status);
		if (node.completedAt !== undefined && ctx.now - node.completedAt < FULL_FLASH_MS) {
			const completionId = `${node.id}:done:${node.completedAt}`;
			if (ctx.flash?.phase(completionId, "status", ctx.now, "full") === undefined) {
				ctx.flash?.observe(completionId, [{ key: "status", text: "" }], node.completedAt);
			}
			ctx.flash?.observe(completionId, [spans.status], node.completedAt);
		}
		if (ctx.flash !== undefined && ctx.seenIds !== undefined && !ctx.seenIds.has(node.id)) {
			ctx.flash.observe(
				node.id,
				list.map(span => ({ ...span, text: "" })),
				ctx.now,
			);
			ctx.seenIds.add(node.id);
		}
		ctx.flash?.observe(node.id, list, ctx.now);
		spansById.set(node.id, spans);
	}
	return spansById;
}

function flashText(
	node: AgentBonsaiNode,
	key: string,
	text: string,
	ctx: AgentBonsaiRenderContext,
): string | undefined {
	if (node.completedAt !== undefined && key !== "status") return undefined;
	const phase = ctx.flash?.phase(
		node.completedAt !== undefined ? `${node.id}:done:${node.completedAt}` : node.id,
		key,
		ctx.now,
		ctx.flashTier,
	);
	if (phase === "bold") {
		const colored = ctx.theme.fg(STATUS_COLORS[node.status], text);
		return ctx.theme.bold?.(colored) ?? colored;
	}
	if (phase === "accent") return ctx.theme.fg(STATUS_COLORS[node.status], text);
	return undefined;
}

function runningPulse(
	node: AgentBonsaiNode,
	text: string,
	color: ThemeColor,
	ctx: AgentBonsaiRenderContext,
): string | undefined {
	if (node.status !== "running") return undefined;
	const phase = activityPulsePhase(ctx.now, ctx.flashTier);
	if (phase === "off") return undefined;
	if (phase === "rest") return ctx.theme.fg("dim", text);
	const colored = ctx.theme.fg(color, text);
	return phase === "bold" ? (ctx.theme.bold?.(colored) ?? colored) : colored;
}

function statusColor(node: AgentBonsaiNode, ctx: AgentBonsaiRenderContext): ThemeColor {
	const flashMs = ctx.flashTier === "subtle" ? SUBTLE_FLASH_MS : FULL_FLASH_MS;
	if (node.status === "completed" && node.completedAt !== undefined && ctx.now - node.completedAt >= flashMs)
		return "dim";
	return STATUS_COLORS[node.status];
}

function spawnGlyph(node: AgentBonsaiNode, ctx: AgentBonsaiRenderContext): string | undefined {
	if (node.status !== "running" || node.depth === 0 || node.createdAt === undefined || ctx.flashTier === "off")
		return undefined;
	const elapsed = ctx.now - node.createdAt;
	if (elapsed < 0) return undefined;
	const frame = Math.floor(elapsed / SPAWN_FRAME_MS);
	const frames = ctx.glyphPreset === "ascii" ? ASCII_SPAWN_GLYPHS : SPAWN_GLYPHS;
	return frames[frame];
}

function renderStatus(node: AgentBonsaiNode, ctx: AgentBonsaiRenderContext): string {
	const glyph = spawnGlyph(node, ctx) ?? resolveGlyph(STATUS_GLYPHS[node.status], ctx.glyphPreset);
	const flashing = flashText(node, "status", glyph, ctx);
	if (flashing !== undefined) return flashing;
	const pulsing = runningPulse(node, glyph, STATUS_COLORS[node.status], ctx);
	if (pulsing !== undefined) return pulsing;
	return ctx.theme.fg(statusColor(node, ctx), glyph);
}

function connectorPrefix(node: AgentBonsaiNode, theme: AgentBonsaiTheme): string {
	if (node.depth === 0) return "";
	const branch = theme.symbol?.(node.isLast ? "tree.last" : "tree.branch") ?? (node.isLast ? "└─" : "├─");
	const unitWidth = visibleWidth(branch) + 1;
	let prefix = "";
	for (const ancestorLast of node.ancestorsLast) {
		if (ancestorLast) prefix += " ".repeat(unitWidth);
		else {
			const vertical = theme.symbol?.("tree.vertical") ?? "│";
			prefix += vertical + " ".repeat(Math.max(0, unitWidth - visibleWidth(vertical)));
		}
	}
	return `${prefix + branch} `;
}

function activityPrefix(node: AgentBonsaiNode, ctx: AgentBonsaiRenderContext): string {
	const indent = " ".repeat(visibleWidth(connectorPrefix(node, ctx.theme)) + 2);
	const marker = ctx.glyphPreset === "ascii" ? ">" : "↳";
	return `${indent}${marker} `;
}

function activityStatusGlyph(
	step: Pick<AgentActivityStep, "status">,
	glyphPreset: SymbolPreset,
	ctx?: AgentBonsaiRenderContext,
): string {
	const glyph = ACTIVITY_STATUS_GLYPHS[step.status][glyphPreset === "ascii" ? "ascii" : "unicode"];
	if (step.status === "active" && ctx !== undefined && activityPulsePhase(ctx.now, ctx.flashTier) === "bold")
		return ctx.theme.bold?.(glyph) ?? glyph;
	return glyph;
}

function activityCellText(step: AgentActivityStep, glyphPreset: SymbolPreset, ctx?: AgentBonsaiRenderContext): string {
	const kind = ACTIVITY_KIND_LABELS[step.kind];
	const status = activityStatusGlyph(step, glyphPreset, ctx);
	return `[${kind} ${step.label} ${status}]`;
}

function fittedActivityCellText(
	step: AgentActivityStep,
	glyphPreset: SymbolPreset,
	width: number,
	ctx: AgentBonsaiRenderContext,
): string {
	const kind = ACTIVITY_KIND_LABELS[step.kind];
	const status = activityStatusGlyph(step, glyphPreset, ctx);
	const fixed = `[${kind}  ${status}]`;
	const labelWidth = width - visibleWidth(fixed);
	const ellipsis = glyphPreset === "ascii" ? Ellipsis.Ascii : Ellipsis.Unicode;
	if (labelWidth <= 0) return width >= 5 ? `[${kind} ${status}]` : "";
	return `[${kind} ${truncateToWidth(step.label, labelWidth, ellipsis)} ${status}]`;
}

function renderActivityCell(step: AgentActivityStep, text: string, ctx: AgentBonsaiRenderContext): string {
	if (step.status === "complete") return ctx.theme.fg("success", text);
	if (step.status === "error") {
		const colored = ctx.theme.fg("error", text);
		return ctx.theme.bold?.(colored) ?? colored;
	}
	return ctx.theme.fg("accent", text);
}

function renderActivityRow(node: AgentBonsaiNode, width: number, ctx: AgentBonsaiRenderContext): string | undefined {
	const steps = node.activitySteps ?? [];
	if (steps.length === 0) return undefined;
	const prefix = activityPrefix(node, ctx);
	const available = width - visibleWidth(prefix);
	if (available < 5) return undefined;

	const arrow = ctx.glyphPreset === "ascii" ? " -> " : " → ";
	const omitted = ctx.glyphPreset === "ascii" ? "... -> " : "… → ";
	const arrowWidth = visibleWidth(arrow);
	const omittedWidth = visibleWidth(omitted);
	let first = steps.length;
	let contentWidth = 0;
	for (let index = steps.length - 1; index >= 0; index--) {
		const step = steps[index] as AgentActivityStep;
		const candidateWidth =
			visibleWidth(activityCellText(step, ctx.glyphPreset)) +
			(first === steps.length ? 0 : arrowWidth + contentWidth);
		const reserve = index === 0 ? 0 : omittedWidth;
		if (candidateWidth + reserve > available) break;
		first = index;
		contentWidth = candidateWidth;
	}

	const renderedPrefix = ctx.theme.fg("dim", prefix);
	if (first === steps.length) {
		const latest = steps.at(-1) as AgentActivityStep;
		const showOmitted = steps.length > 1 && omittedWidth + 5 <= available;
		const text = fittedActivityCellText(latest, ctx.glyphPreset, available - (showOmitted ? omittedWidth : 0), ctx);
		if (text.length === 0) return undefined;
		const renderedOmitted = showOmitted ? ctx.theme.fg("dim", omitted) : "";
		return `${renderedPrefix}${renderedOmitted}${renderActivityCell(latest, text, ctx)}`;
	}
	const selected = steps.slice(first);
	const renderedSteps = selected.map(step =>
		renderActivityCell(step, activityCellText(step, ctx.glyphPreset, ctx), ctx),
	);
	const renderedArrow = ctx.theme.fg("dim", arrow);
	const renderedOmitted = first === 0 ? "" : ctx.theme.fg("dim", omitted);
	return `${renderedPrefix}${renderedOmitted}${renderedSteps.join(renderedArrow)}`;
}

function provenanceCellText(
	event: AgentProvenanceEvent,
	glyphPreset: SymbolPreset,
	ctx?: AgentBonsaiRenderContext,
): string {
	const kind = PROVENANCE_KIND_LABELS[event.kind];
	const status = activityStatusGlyph(event, glyphPreset, ctx);
	return `[${kind} ${event.label} ${status}]`;
}

function fittedProvenanceCellText(
	event: AgentProvenanceEvent,
	glyphPreset: SymbolPreset,
	width: number,
	ctx: AgentBonsaiRenderContext,
): string {
	const kind = PROVENANCE_KIND_LABELS[event.kind];
	const status = activityStatusGlyph(event, glyphPreset, ctx);
	const fixed = `[${kind}  ${status}]`;
	const labelWidth = width - visibleWidth(fixed);
	const ellipsis = glyphPreset === "ascii" ? Ellipsis.Ascii : Ellipsis.Unicode;
	if (labelWidth <= 0) return width >= 5 ? `[${kind} ${status}]` : "";
	return `[${kind} ${truncateToWidth(event.label, labelWidth, ellipsis)} ${status}]`;
}

function renderProvenanceCell(event: AgentProvenanceEvent, text: string, ctx: AgentBonsaiRenderContext): string {
	if (event.status === "complete") return ctx.theme.fg("success", text);
	if (event.status === "error") {
		const colored = ctx.theme.fg("error", text);
		return ctx.theme.bold?.(colored) ?? colored;
	}
	return ctx.theme.fg("accent", text);
}

function renderProvenanceRow(node: AgentBonsaiNode, width: number, ctx: AgentBonsaiRenderContext): string | undefined {
	const events = node.provenance ?? [];
	if (events.length === 0) return undefined;
	const prefix = `${activityPrefix(node, ctx)}${node.cohortLabel}: `;
	const available = width - visibleWidth(prefix);
	if (available < 5) return undefined;

	const chronology = ctx.glyphPreset === "ascii" ? " | " : " · ";
	const omitted = ctx.glyphPreset === "ascii" ? "... | " : "… · ";
	const chronologyWidth = visibleWidth(chronology);
	const omittedWidth = visibleWidth(omitted);
	let first = events.length;
	let contentWidth = 0;
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index] as AgentProvenanceEvent;
		const candidateWidth =
			visibleWidth(provenanceCellText(event, ctx.glyphPreset)) +
			(first === events.length ? 0 : chronologyWidth + contentWidth);
		const reserve = index === 0 ? 0 : omittedWidth;
		if (candidateWidth + reserve > available) break;
		first = index;
		contentWidth = candidateWidth;
	}

	const renderedPrefix = ctx.theme.fg("dim", prefix);
	if (first === events.length) {
		const latest = events.at(-1) as AgentProvenanceEvent;
		const showOmitted = events.length > 1 && omittedWidth + 5 <= available;
		const renderedOmitted = showOmitted ? ctx.theme.fg("dim", omitted) : "";
		const latestAvailable = available - (showOmitted ? omittedWidth : 0);
		const cell = fittedProvenanceCellText(latest, ctx.glyphPreset, latestAvailable, ctx);
		if (cell.length === 0) return undefined;
		return `${renderedPrefix}${renderedOmitted}${renderProvenanceCell(latest, cell, ctx)}`;
	}

	const selected = events
		.slice(first)
		.map(event => renderProvenanceCell(event, provenanceCellText(event, ctx.glyphPreset, ctx), ctx));
	const renderedChronology = ctx.theme.fg("dim", chronology);
	const renderedOmitted = first === 0 ? "" : ctx.theme.fg("dim", omitted);
	return `${renderedPrefix}${renderedOmitted}${selected.join(renderedChronology)}`;
}

function renderGist(node: AgentBonsaiNode, text: string, ctx: AgentBonsaiRenderContext): string {
	const flashing = flashText(node, "gist", text, ctx);
	if (flashing !== undefined || node.gist === undefined) return flashing ?? ctx.theme.fg("dim", text);
	const tokens = text.split(/(\s+|"[^"]*"|'[^']*'|`[^`]*`|(?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+|\b\d+(?:\.\d+)?\b)/g);
	let actionColored = false;
	return tokens
		.map(token => {
			if (token.length === 0 || /^\s+$/.test(token)) return token;
			if (!actionColored) {
				actionColored = true;
				return ctx.theme.fg("syntaxFunction", token);
			}
			if (/^(?:"[^"]*"|'[^']*'|`[^`]*`)$/.test(token)) return ctx.theme.fg("syntaxString", token);
			if (/^\d+(?:\.\d+)?$/.test(token)) return ctx.theme.fg("syntaxNumber", token);
			if (token.includes("/")) return ctx.theme.fg("syntaxVariable", token);
			return token;
		})
		.join("");
}

function renderPlainSpan(
	node: AgentBonsaiNode,
	key: "name" | "model" | "task",
	text: string,
	ctx: AgentBonsaiRenderContext,
): string {
	const flashing = flashText(node, key, text, ctx);
	if (flashing !== undefined) return flashing;
	if (key === "name") return ctx.theme.fg(statusColor(node, ctx), text);
	return ctx.theme.fg("dim", text);
}

function renderSkill(node: AgentBonsaiNode, text: string, ctx: AgentBonsaiRenderContext): string {
	const disclosureUri = buildSkillDisclosureUri(node);
	if (disclosureUri === undefined) return "";
	const color = node.status === "completed" && statusColor(node, ctx) === "dim" ? "dim" : "accent";
	const styled = flashText(node, "skill", text, ctx) ?? ctx.theme.fg(color, text);
	if (!(ctx.hyperlinks ?? hyperlinksSupported())) return styled;
	return osc8Hyperlink(disclosureUri, styled);
}

function nameWidths(nodes: readonly AgentBonsaiNode[]): ReadonlyMap<number, number> {
	const names = new Map<number, number>();
	for (const node of nodes) {
		const name = `${node.cohortLabel} ${node.name}`;
		names.set(node.depth, Math.max(names.get(node.depth) ?? 0, visibleWidth(name)));
	}
	return names;
}

/** The model every node in a visible set shares, or `undefined` when it varies or isn't set on at least two nodes. */
export function sharedBonsaiModel(nodes: readonly AgentBonsaiNode[]): string | undefined {
	if (nodes.length < 2) return undefined;
	const first = nodes[0]?.model;
	if (first === undefined) return undefined;
	return nodes.every(node => node.model === first) ? first : undefined;
}

function renderNode(
	node: AgentBonsaiNode,
	spans: AgentBonsaiRowSpans,
	width: number,
	nameWidth: number,
	ctx: AgentBonsaiRenderContext,
	showModel: boolean,
	dedupedTask = false,
	dedupedModel = false,
): string {
	const connector = ctx.theme.fg(statusColor(node, ctx), connectorPrefix(node, ctx.theme));
	const status = renderStatus(node, ctx);
	const name = renderPlainSpan(node, "name", spans.name.text, ctx);
	const namePadding = " ".repeat(Math.max(0, nameWidth - visibleWidth(spans.name.text)));
	const base = `${connector}${status} ${name}`;
	const collisionChip = spans.collision.text.length > 0 ? `  ${ctx.theme.fg("error", spans.collision.text)}` : "";
	const model = showModel && !dedupedModel ? spans.model.text : "";
	const skill = spans.skill.text;
	const gist = dedupedTask && spans.gist.text.length === 0 ? "" : spans.gist.text || spans.task.text;
	const task =
		spans.gist.text.length > 0 && spans.gist.text !== spans.task.text && !dedupedTask ? spans.task.text : "";

	// Lead with the differentiator (gist), then the skill chip, then the model
	// chip — the part most likely to be identical across every visible row and
	// so the one dropped first when width is tight.
	const assemble = (
		fittedGist: string,
		includeSkill: boolean,
		includeModel: boolean,
		includeTask: boolean,
		paddedName = true,
	): string => {
		let row = base + (paddedName ? namePadding : "") + collisionChip;
		if (fittedGist.length > 0) {
			const work =
				spans.gist.text.length > 0
					? renderGist(node, fittedGist, ctx)
					: renderPlainSpan(node, "task", fittedGist, ctx);
			row += `  ${work}`;
		}
		if (includeSkill && skill.length > 0) row += `  ${renderSkill(node, skill, ctx)}`;
		if (includeModel && model.length > 0) row += `  ${renderPlainSpan(node, "model", model, ctx)}`;
		if (includeTask && task.length > 0)
			row += `  ${ctx.theme.fg("dim", "·")} ${renderPlainSpan(node, "task", task, ctx)}`;
		return row.trimEnd();
	};

	const candidates = [
		assemble(gist, true, true, true),
		assemble(gist, true, true, false),
		assemble(gist, true, false, false),
		assemble(gist, false, false, false),
		assemble(gist, false, false, false, false),
	];
	for (const candidate of candidates) if (visibleWidth(candidate) <= width) return candidate;
	const ellipsis = ctx.glyphPreset === "ascii" ? Ellipsis.Ascii : Ellipsis.Unicode;
	const ellipsisWidth = ctx.glyphPreset === "ascii" ? 3 : 1;
	const gistWidth = width - visibleWidth(base) - 2;
	if (gist.length > 0 && gistWidth > ellipsisWidth) {
		return assemble(truncateToWidth(gist, gistWidth, ellipsis), false, false, false, false);
	}
	return visibleWidth(base) <= width ? base : truncateToWidth(base, width, ellipsis);
}

export function renderAgentBonsaiRows(
	snapshot: AgentBonsaiSnapshot,
	width: number,
	ctx: AgentBonsaiRenderContext,
): readonly string[] {
	if (!snapshot.visible || width <= 0) return [];
	const spansById = observeRows(snapshot, ctx);
	const widths = nameWidths(snapshot.nodes);
	const showModel = sharedBonsaiModel(snapshot.nodes) === undefined;
	const rows: string[] = [];
	// Sibling-run dedupe is order-local: a row repeats its predecessor's task
	// tail or model chip only while the same depth continues. Main never dedupes.
	let prev: { depth: number; task: string; model: string } | undefined;
	for (const node of snapshot.nodes) {
		const spans = spansById.get(node.id) as AgentBonsaiRowSpans;
		const sibling = node.depth > 0 && prev?.depth === node.depth ? prev : undefined;
		const dedupedTask = spans.task.text.length > 0 && spans.task.text === sibling?.task;
		const dedupedModel = showModel && spans.model.text.length > 0 && spans.model.text === sibling?.model;
		prev = { depth: node.depth, task: spans.task.text, model: spans.model.text };
		rows.push(renderNode(node, spans, width, widths.get(node.depth) ?? 0, ctx, showModel, dedupedTask, dedupedModel));
		const activity = renderActivityRow(node, width, ctx);
		if (activity !== undefined) rows.push(activity);
		const provenance = renderProvenanceRow(node, width, ctx);
		if (provenance !== undefined) rows.push(provenance);
	}
	if (snapshot.hiddenCount > 0)
		rows.push(ctx.theme.fg("dim", truncateToWidth(`… +${snapshot.hiddenCount} more`, width)));
	return rows;
}
