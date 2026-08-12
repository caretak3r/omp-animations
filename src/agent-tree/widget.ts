import type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type FlashTier, FlashTracker, type PhraseSpan } from "../animations-box/status-line";
import { type AccentColor, accentToThemeColor } from "../appearance";
import { type GlyphKey, resolveGlyph } from "../glyph-presets";
import { AnimatedWidget, type AnimatedWidgetHost, type AnimatedWidgetOptions, type MotionPolicy } from "../kit";
import type { AgentNode, AgentTreeSnapshot, AgentTreeStatus } from "./state";

/** Theme operations used by the Agent Tree renderer. */
export type AgentTreeTheme = Pick<Theme, "fg" | "bold" | "symbol">;

/** Built-in primary color. A configured appearance accent replaces this token. */
export const AGENT_TREE_ACCENT: ThemeColor = "accent";

const STATUS_GLYPHS: Readonly<Record<AgentTreeStatus, GlyphKey>> = {
	running: "box.dot.live",
	idle: "box.dot.idle",
	parked: "box.dot.notable",
	aborted: "box.dot.alert",
};

interface AgentTreeRowSpans {
	readonly status: PhraseSpan;
	readonly name: PhraseSpan;
	readonly model: PhraseSpan;
	readonly gist: PhraseSpan;
	readonly task: PhraseSpan;
}

export interface AgentTreeRenderContext {
	readonly theme: AgentTreeTheme;
	readonly glyphPreset: SymbolPreset;
	readonly accent: ThemeColor;
	readonly now: number;
	readonly flashTier: FlashTier;
	readonly flash?: FlashTracker;
	/** Widget-owned row identities. Supplying this set enables the new-row flash. */
	readonly seenIds?: Set<string>;
}

function modelLabel(node: AgentNode): string {
	if (node.modelTail !== undefined) return node.modelTail;
	return node.status === "parked" ? "(parked)" : "";
}

function gistLabel(node: AgentNode): string {
	if (node.gist !== undefined) return node.gist;
	if (node.status === "idle") return "(idle)";
	if (node.status === "aborted") return "(aborted)";
	return "";
}

function rowSpans(node: AgentNode): AgentTreeRowSpans {
	return {
		status: { key: "status", text: node.status },
		name: { key: "name", text: node.name },
		model: { key: "model", text: modelLabel(node) },
		gist: { key: "gist", text: gistLabel(node) },
		task: { key: "task", text: node.task ?? "" },
	};
}

function spanList(spans: AgentTreeRowSpans): readonly PhraseSpan[] {
	return [spans.status, spans.name, spans.model, spans.gist, spans.task];
}

function observeRows(snapshot: AgentTreeSnapshot, ctx: AgentTreeRenderContext): Map<string, AgentTreeRowSpans> {
	const currentIds = new Set(snapshot.nodes.map(node => node.id));
	if (ctx.seenIds !== undefined) {
		for (const id of ctx.seenIds) {
			if (!currentIds.has(id)) ctx.seenIds.delete(id);
		}
	}

	const spansById = new Map<string, AgentTreeRowSpans>();
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

function flashPhase(node: AgentNode, key: string, ctx: AgentTreeRenderContext): "bold" | "accent" | undefined {
	return ctx.flash?.phase(node.id, key, ctx.now, ctx.flashTier);
}

function flashText(node: AgentNode, key: string, text: string, ctx: AgentTreeRenderContext): string | undefined {
	const phase = flashPhase(node, key, ctx);
	if (phase === "bold") return ctx.theme.bold(ctx.theme.fg(ctx.accent, text));
	if (phase === "accent") return ctx.theme.fg(ctx.accent, text);
	return undefined;
}

function renderStatusDot(node: AgentNode, ctx: AgentTreeRenderContext): string {
	const glyph = resolveGlyph(STATUS_GLYPHS[node.status], ctx.glyphPreset);
	if (node.status === "aborted") return ctx.theme.bold(ctx.theme.fg("error", glyph));
	const flashing = flashText(node, "status", glyph, ctx);
	if (flashing !== undefined) return flashing;
	return ctx.theme.fg(node.status === "running" ? ctx.accent : "dim", glyph);
}

function renderSpan(
	node: AgentNode,
	key: "name" | "model" | "gist" | "task",
	text: string,
	ctx: AgentTreeRenderContext,
): string {
	const flashing = flashText(node, key, text, ctx);
	if (flashing !== undefined) return flashing;
	if (key === "model" || key === "task" || (key === "gist" && node.gist === undefined)) {
		return ctx.theme.fg("dim", text);
	}
	return text;
}

function connectorPrefix(node: AgentNode, theme: AgentTreeTheme): string {
	if (node.depth === 0) return "";
	const branch = theme.symbol(node.isLast ? "tree.last" : "tree.branch");
	const branchWidth = visibleWidth(branch);
	const unitWidth = branchWidth + 1;
	let prefix = "";
	for (const ancestorLast of node.ancestorsLast) {
		if (ancestorLast) {
			prefix += " ".repeat(unitWidth);
		} else {
			const vertical = theme.symbol("tree.vertical");
			prefix += vertical + " ".repeat(Math.max(0, unitWidth - visibleWidth(vertical)));
		}
	}
	return `${prefix + branch} `;
}

function renderConnectorPrefix(node: AgentNode, theme: AgentTreeTheme): string {
	return theme.fg("dim", connectorPrefix(node, theme));
}

function maxWidths(nodes: readonly AgentNode[]): { names: ReadonlyMap<number, number>; model: number } {
	const names = new Map<number, number>();
	let model = 0;
	for (const node of nodes) {
		names.set(node.depth, Math.max(names.get(node.depth) ?? 0, visibleWidth(node.name)));
		model = Math.max(model, visibleWidth(modelLabel(node)));
	}
	return { names, model };
}

function renderNode(
	node: AgentNode,
	spans: AgentTreeRowSpans,
	width: number,
	nameWidth: number,
	modelWidth: number,
	ctx: AgentTreeRenderContext,
): string {
	const connector = renderConnectorPrefix(node, ctx.theme);
	const dot = renderStatusDot(node, ctx);
	const name = renderSpan(node, "name", spans.name.text, ctx);
	const namePadding = " ".repeat(Math.max(0, nameWidth - visibleWidth(spans.name.text)));
	const base = `${connector}${dot}  ${name}${namePadding}`;
	const model = spans.model.text;
	const gist = spans.gist.text;
	const task = spans.task.text;

	const assemble = (includeModel: boolean, fittedGist: string, includeTask: boolean): string => {
		let row = base;
		if (includeModel && modelWidth > 0 && (model.length > 0 || fittedGist.length > 0 || includeTask)) {
			const renderedModel = model.length > 0 ? renderSpan(node, "model", model, ctx) : "";
			row += `  ${renderedModel}${" ".repeat(Math.max(0, modelWidth - visibleWidth(model)))}`;
		}
		if (fittedGist.length > 0) row += `  ${renderSpan(node, "gist", fittedGist, ctx)}`;
		if (includeTask && task.length > 0) {
			row += `  ${ctx.theme.fg("dim", "·")} ${renderSpan(node, "task", task, ctx)}`;
		}
		return row.trimEnd();
	};

	const full = assemble(true, gist, true);
	if (visibleWidth(full) <= width) return full;

	const withoutTask = assemble(true, gist, false);
	if (visibleWidth(withoutTask) <= width) return withoutTask;

	if (gist.length > 0) {
		const withModelPrefix = assemble(true, "", false);
		const withModelRoom = width - visibleWidth(withModelPrefix) - 2;
		if (withModelRoom > 0) {
			return assemble(true, truncateToWidth(gist, withModelRoom), false);
		}

		const withoutModelPrefix = assemble(false, "", false);
		const withoutModelRoom = width - visibleWidth(withoutModelPrefix) - 2;
		if (withoutModelRoom > 0) {
			return assemble(false, truncateToWidth(gist, withoutModelRoom), false);
		}
	}

	const withoutModel = assemble(false, "", false);
	return visibleWidth(withoutModel) <= width ? withoutModel : truncateToWidth(withoutModel, width);
}

/** Render the current visible snapshot, including its overflow tail. */
export function renderAgentTreeRows(
	snapshot: AgentTreeSnapshot,
	width: number,
	ctx: AgentTreeRenderContext,
): readonly string[] {
	if (!snapshot.visible || width <= 0) return [];
	const spansById = observeRows(snapshot, ctx);
	const widths = maxWidths(snapshot.nodes);
	const rows = snapshot.nodes.map(node =>
		renderNode(
			node,
			spansById.get(node.id) as AgentTreeRowSpans,
			width,
			widths.names.get(node.depth) ?? 0,
			widths.model,
			ctx,
		),
	);
	if (snapshot.hiddenCount > 0) {
		rows.push(ctx.theme.fg("dim", truncateToWidth(`… +${snapshot.hiddenCount} more`, width)));
	}
	return rows;
}

/** Minimal state seam consumed by the widget. */
export interface AgentTreeWidgetState {
	snapshot(): AgentTreeSnapshot;
}

export interface AgentTreeWidgetOptions extends AnimatedWidgetOptions {
	readonly state: AgentTreeWidgetState;
	readonly theme: AgentTreeTheme;
	readonly accentColor?: AccentColor;
	readonly glyphPreset?: SymbolPreset;
}

/** Animated component for the live agent roster. Registry polling stays in the controller. */
export class AgentTreeWidget extends AnimatedWidget {
	#state: AgentTreeWidgetState;
	#theme: AgentTreeTheme;
	#policy: MotionPolicy;
	#tui: AnimatedWidgetHost;
	#accent: ThemeColor;
	#glyphPreset: SymbolPreset;
	#flash = new FlashTracker();
	#seenIds = new Set<string>();

	constructor(options: AgentTreeWidgetOptions) {
		super(options);
		this.#state = options.state;
		this.#theme = options.theme;
		this.#policy = options.policy;
		this.#tui = options.tui;
		this.#accent = options.accentColor === undefined ? AGENT_TREE_ACCENT : accentToThemeColor(options.accentColor);
		this.#glyphPreset = options.glyphPreset ?? "unicode";
	}

	/** Invalidate and repaint after an event-driven registry refresh. */
	refresh(): void {
		this.markDirty();
		this.#tui.requestComponentRender(this);
	}

	renderFrame(width: number): readonly string[] {
		return renderAgentTreeRows(this.#state.snapshot(), width, {
			theme: this.#theme,
			glyphPreset: this.#glyphPreset,
			accent: this.#accent,
			now: this.elapsedMs,
			flashTier: this.#policy.tier,
			flash: this.#flash,
			seenIds: this.#seenIds,
		});
	}
}
