import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { FlashTier, FlashTracker, PhraseSpan } from "../animations-box/status-line";
import type { GlyphKey } from "../glyph-presets";
import { resolveGlyph } from "../glyph-presets";
import { hyperlinksSupported, osc8Hyperlink } from "./hyperlinks";
import type { AgentBonsaiNode, AgentBonsaiSnapshot, AgentBonsaiStatus } from "./state";

export type AgentBonsaiTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold" | "symbol">>;

const STATUS_GLYPHS: Readonly<Record<AgentBonsaiStatus, GlyphKey>> = {
	running: "box.dot.live",
	idle: "box.dot.idle",
	parked: "box.dot.notable",
	aborted: "box.dot.alert",
};

const STATUS_COLORS: Readonly<Record<AgentBonsaiStatus, ThemeColor>> = {
	running: "syntaxFunction",
	idle: "success",
	parked: "warning",
	aborted: "error",
};

interface AgentBonsaiRowSpans {
	readonly status: PhraseSpan;
	readonly name: PhraseSpan;
	readonly model: PhraseSpan;
	readonly skill: PhraseSpan;
	readonly gist: PhraseSpan;
	readonly task: PhraseSpan;
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

function statusLabel(status: AgentBonsaiStatus): string {
	if (status === "idle") return "delivered";
	return status;
}

function modelLabel(node: AgentBonsaiNode): string {
	if (node.model !== undefined) return node.model;
	return node.status === "parked" ? "(parked)" : "";
}

function skillLabel(node: AgentBonsaiNode): string {
	const active = node.activeSkill;
	return active === undefined ? "" : `skill:${active.name}`;
}

/** Data URI opened by the active-skill link; keeps disclosure local to the terminal host. */
export function buildSkillDisclosureUri(node: AgentBonsaiNode): string | undefined {
	const active = node.activeSkill;
	if (active === undefined) return undefined;
	const loaded = node.loadedSkills.length > 0 ? node.loadedSkills : [active];
	const text = [
		`Agent Bonsai · ${node.cohortLabel} ${node.name}`,
		`Active skill: ${active.name}`,
		`Loaded skills (${loaded.length}):`,
		...loaded.map(skill => `- ${skill.name} — ${skill.path}`),
	].join("\n");
	return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function gistLabel(node: AgentBonsaiNode): string {
	if (node.gist !== undefined) return node.gist;
	if (node.status === "idle") return "(delivered)";
	if (node.status === "parked") return "(parked)";
	if (node.status === "aborted") return "(aborted)";
	return "";
}

function rowSpans(node: AgentBonsaiNode): AgentBonsaiRowSpans {
	return {
		status: { key: "status", text: statusLabel(node.status) },
		name: { key: "name", text: `${node.cohortLabel} ${node.name}` },
		model: { key: "model", text: modelLabel(node) },
		skill: { key: "skill", text: skillLabel(node) },
		gist: { key: "gist", text: gistLabel(node) },
		task: { key: "task", text: node.task ?? "" },
	};
}

function spanList(spans: AgentBonsaiRowSpans): readonly PhraseSpan[] {
	return [spans.status, spans.name, spans.model, spans.skill, spans.gist, spans.task];
}

function observeRows(snapshot: AgentBonsaiSnapshot, ctx: AgentBonsaiRenderContext): Map<string, AgentBonsaiRowSpans> {
	const currentIds = new Set(snapshot.nodes.map(node => node.id));
	if (ctx.seenIds !== undefined) {
		for (const id of ctx.seenIds) if (!currentIds.has(id)) ctx.seenIds.delete(id);
	}
	const spansById = new Map<string, AgentBonsaiRowSpans>();
	for (const node of snapshot.nodes) {
		const spans = rowSpans(node);
		const list = spanList(spans);
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
	const phase = ctx.flash?.phase(node.id, key, ctx.now, ctx.flashTier);
	if (phase === "bold") {
		const colored = ctx.theme.fg(STATUS_COLORS[node.status], text);
		return ctx.theme.bold?.(colored) ?? colored;
	}
	if (phase === "accent") return ctx.theme.fg(STATUS_COLORS[node.status], text);
	return undefined;
}

function renderStatus(node: AgentBonsaiNode, ctx: AgentBonsaiRenderContext): string {
	const glyph = resolveGlyph(STATUS_GLYPHS[node.status], ctx.glyphPreset);
	const flashing = flashText(node, "status", glyph, ctx);
	if (flashing !== undefined) return flashing;
	const colored = ctx.theme.fg(STATUS_COLORS[node.status], glyph);
	return node.status === "aborted" ? (ctx.theme.bold?.(colored) ?? colored) : colored;
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
	if (key === "name") return ctx.theme.fg(STATUS_COLORS[node.status], text);
	return ctx.theme.fg("dim", text);
}

/** The chip links to its disclosure in every phase — the flash styling only recolors the text. */
function renderSkill(node: AgentBonsaiNode, text: string, ctx: AgentBonsaiRenderContext): string {
	const disclosureUri = buildSkillDisclosureUri(node);
	if (disclosureUri === undefined) return "";
	const styled = flashText(node, "skill", text, ctx) ?? ctx.theme.fg("accent", text);
	if (!(ctx.hyperlinks ?? hyperlinksSupported())) return styled;
	return osc8Hyperlink(disclosureUri, styled);
}

function maxWidths(nodes: readonly AgentBonsaiNode[]): { names: ReadonlyMap<number, number>; model: number } {
	const names = new Map<number, number>();
	let model = 0;
	for (const node of nodes) {
		const name = `${node.cohortLabel} ${node.name}`;
		names.set(node.depth, Math.max(names.get(node.depth) ?? 0, visibleWidth(name)));
		model = Math.max(model, visibleWidth(modelLabel(node)));
	}
	return { names, model };
}

function renderNode(
	node: AgentBonsaiNode,
	spans: AgentBonsaiRowSpans,
	width: number,
	nameWidth: number,
	modelWidth: number,
	ctx: AgentBonsaiRenderContext,
): string {
	const connector = ctx.theme.fg(STATUS_COLORS[node.status], connectorPrefix(node, ctx.theme));
	const status = renderStatus(node, ctx);
	const name = renderPlainSpan(node, "name", spans.name.text, ctx);
	const namePadding = " ".repeat(Math.max(0, nameWidth - visibleWidth(spans.name.text)));
	const base = `${connector}${status} ${name}${namePadding}`;
	const model = spans.model.text;
	const skill = spans.skill.text;
	const gist = spans.gist.text;
	const task = spans.task.text;

	const assemble = (
		includeModel: boolean,
		includeSkill: boolean,
		fittedGist: string,
		includeTask: boolean,
	): string => {
		let row = base;
		if (
			includeModel &&
			modelWidth > 0 &&
			(model.length > 0 || includeSkill || fittedGist.length > 0 || includeTask)
		) {
			const renderedModel = model.length > 0 ? renderPlainSpan(node, "model", model, ctx) : "";
			row += `  ${renderedModel}${" ".repeat(Math.max(0, modelWidth - visibleWidth(model)))}`;
		}
		if (includeSkill && skill.length > 0) row += `  ${renderSkill(node, skill, ctx)}`;
		if (fittedGist.length > 0) row += `  ${renderGist(node, fittedGist, ctx)}`;
		if (includeTask && task.length > 0)
			row += `  ${ctx.theme.fg("dim", "·")} ${renderPlainSpan(node, "task", task, ctx)}`;
		return row.trimEnd();
	};

	const candidates = [
		assemble(true, true, gist, true),
		assemble(true, true, gist, false),
		assemble(true, true, "", false),
		assemble(true, false, gist, false),
		assemble(true, false, "", false),
	];
	for (const candidate of candidates) if (visibleWidth(candidate) <= width) return candidate;
	const nameOnly = assemble(false, false, "", false);
	return visibleWidth(nameOnly) <= width ? nameOnly : truncateToWidth(nameOnly, width);
}

export function renderAgentBonsaiRows(
	snapshot: AgentBonsaiSnapshot,
	width: number,
	ctx: AgentBonsaiRenderContext,
): readonly string[] {
	if (!snapshot.visible || width <= 0) return [];
	const spansById = observeRows(snapshot, ctx);
	const widths = maxWidths(snapshot.nodes);
	const rows = snapshot.nodes.map(node =>
		renderNode(
			node,
			spansById.get(node.id) as AgentBonsaiRowSpans,
			width,
			widths.names.get(node.depth) ?? 0,
			widths.model,
			ctx,
		),
	);
	if (snapshot.hiddenCount > 0)
		rows.push(ctx.theme.fg("dim", truncateToWidth(`… +${snapshot.hiddenCount} more`, width)));
	return rows;
}
