#!/usr/bin/env bun
/**
 * Grades captured Audit Box frames against the render invariants we keep breaking.
 *
 * Every rule below is a bug we found by squinting at a screenshot. Once a bead is
 * fixed its rule stays as the ratchet: the next run cannot silently regress it.
 * Rules read glyphs and text only — colour is not captured, so anything that can
 * only be judged in colour does not belong here.
 *
 *   bun run probe:lint                     # newest run under .frames/
 *   bun run probe:lint -- .frames/run-x    # a specific run
 *   bun run probe:lint -- --json
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TemporalEvidenceStage } from "../src/animations-box/temporal-evidence";
import { PROGRESS_BAR_CELLS } from "../src/progress-bar";

const BORDERED = /^\s*[│┃|](?<body>.*)[│┃|]\s*$/u;
const DOT = /^(?<dot>[○◐●◆◇•▪])\s+(?<rest>.*)$/u;
const TREE = /^[\s│]*[├└╰┌┬─]/u;
const LABEL = /^(?<label>\S+)(?:\s{2,}(?<value>.*))?$/u;
const SIMPLE_BUDGET = /(?:^| · )(?:\[?[\u2588-\u258f\u2591#….-]*\]?(?:…|\.{3})? )?\d+% budget(?: · |$)/u;
const AGENT_ROW = /^[\s│┃├└╰┌┬─|+`-]*[○◐●◆◇•▪✓✗×!]\s+(?:M|A[\d?]+)\s+\S+(?: \(inferred\))?(?=\s{2,}|$)/u;
const AGENT_MODEL =
	/^[\s│┃├└╰┌┬─|+`-]*[○◐●◆◇•▪✓✗×!]\s+(?:M|A[\d?]+)\s+\S+(?: \(inferred\))?\s{2,}(?<model>[\w-]+\/[\w.-]+(?::\w+)?)(?=\s{2,}|$)/u;
const AGENT_DETAIL_ROW = /^↳/u;
const BAR_RUN = /\[?[\u2588-\u258f\u2591#-]+(?:…|\.{3})?\]?(?:…|\.{3})?|\[(?:…|\.{3})?\]?|\]/gu;
const COMPLETE_BAR = new RegExp(`^\\[[\\u2588-\\u258f\\u2591#-]{${PROGRESS_BAR_CELLS}}\\]$`, "u");

interface Row {
	line: string;
	kind: "labeled" | "tree" | "header" | "summary" | "other";
	dot: string | null;
	label: string;
	value: string;
	body: string;
}

interface Box {
	rows: Row[];
	widths: number[];
	completeBorder: boolean;
}

interface Frame {
	file: string;
	boxes: Box[];
	text: string;
}

export type FrameLintCapability = "supported" | "unsupported" | "unknown";

export interface FrameLintMetadata {
	semanticStage?: TemporalEvidenceStage | "expired" | "none";
	motionFrameCount?: number;
	directionalConnectorCount?: number;
	explicitRelationCount?: number;
	observedDeltaCount?: number;
	writeLabelCount?: number;
	staleObservationCount?: number;
	retainedObservationCount?: number;
	lifecycleStateCount?: number;
	textualLifecycleMarkerCount?: number;
	pendingCount?: number;
	completedCount?: number;
	distinctLifecycleProjectionCount?: number;
	privateContentFieldCount?: number;
	sourceProjectionCount?: number;
	capability?: FrameLintCapability;
	placeholderRowCount?: number;
	idleOptionalRowCount?: number;
	inferredRetryCount?: number;
	inferredCancellationCount?: number;
	contentWidth?: number;
	availableWidth?: number;
	requiredRowCount?: number;
	renderedRequiredRowCount?: number;
}

export interface Violation {
	rule: string;
	bead: string;
	file: string;
	evidence: string;
}

interface Rule {
	id: string;
	bead: string;
	says: string;
	check: (frame: Frame, metadata?: Readonly<FrameLintMetadata>) => string[];
}

function parseRow(line: string): Row {
	const bordered = BORDERED.exec(line);
	const body = (bordered?.groups?.body ?? line.replace(/^\s*[│┃|]\s?/, "").replace(/[│┃|]\s*$/u, "")).trim();
	const dotted = DOT.exec(body);
	const dot = dotted?.groups?.dot ?? null;
	const rest = dotted?.groups?.rest ?? body;
	if (TREE.test(body)) return { line, kind: "tree", dot, label: "", value: rest, body };
	if (SIMPLE_BUDGET.test(body)) return { line, kind: "summary", dot, label: "", value: body, body };
	const labeled = LABEL.exec(rest);
	// A lone word with no glyph and no value is a group heading ("agents"), not a data row.
	// The heading may carry a " · <model>" suffix when every visible node shares one model.
	const heading = dot === null ? /^(?<label>\S+)(?: · .+)?$/u.exec(rest) : null;
	if (heading) return { line, kind: "header", dot, label: heading.groups?.label ?? rest, value: "", body };
	if (labeled && rest.length > 0) {
		return {
			line,
			kind: "labeled",
			dot,
			label: labeled.groups?.label ?? "",
			value: (labeled.groups?.value ?? "").trim(),
			body,
		};
	}
	return { line, kind: "other", dot, label: "", value: rest, body };
}

export function parseFrame(file: string, text: string): Frame {
	const boxes: Box[] = [];
	let lines: string[] = [];
	const finish = (): void => {
		if (lines.length === 0) return;
		const rows = lines.filter(line => !/^\s*[╭┌╰└─━]/u.test(line)).map(parseRow);
		const labels = new Set(rows.filter(row => row.kind === "labeled").map(row => row.label));
		const detailed =
			rows.some(row => row.label === "context" && (row.dot !== null || /% (?:budget|quota)\b/u.test(row.value))) ||
			["context", "cache", "audit", "limits", "files"].filter(label => labels.has(label)).length >= 3;
		// Text can identify surviving status rows, not an empty or wholly erased widget.
		if (detailed || rows.some(row => row.kind === "summary")) {
			boxes.push({
				rows,
				widths: lines.map(line => Bun.stringWidth(line.trimEnd())),
				completeBorder:
					/^\s*[╭┌].*[╮┐]\s*$/u.test(lines[0] ?? "") &&
					/^\s*[╰└].*[╯┘]\s*$/u.test(lines.at(-1) ?? "") &&
					rows.every(row => BORDERED.test(row.line)),
			});
		}
		lines = [];
	};
	for (const line of text.split("\n")) {
		if (/^\s*[╭┌]/u.test(line)) finish();
		if (/^\s*[╭┌╰└│┃|─━]/u.test(line) || /^\s*[╭┌]/u.test(lines[0] ?? "")) {
			lines.push(line);
			if (/^\s*[╰└]/u.test(line)) finish();
		} else {
			finish();
		}
	}
	finish();
	return { file, boxes, text };
}

const labeledRows = (frame: Frame): Row[] => frame.boxes.flatMap(box => box.rows.filter(row => row.kind === "labeled"));

const allRows = (frame: Frame): Row[] => frame.boxes.flatMap(box => box.rows);

/**
 * Screen column where a row's wide-only tail begins, or -1 when it has no tail.
 * Measured across the whole row so misalignment is judged the way the eye judges
 * it, but starting past the label gap — labels are padded to a column, and that
 * padding is not a tail.
 */
function tailColumn(row: Row): number {
	const valueAt = row.body.lastIndexOf(row.value);
	if (row.value.length === 0 || valueAt === -1) return -1;
	let last = -1;
	for (const hit of row.value.matchAll(/\s{3,}/g)) last = (hit.index ?? 0) + hit[0].length;
	return last === -1 ? -1 : Bun.stringWidth(row.body.slice(0, valueAt + last));
}

export const RULES: Rule[] = [
	{
		id: "blank-value",
		bead: "daw.1",
		says: "a labeled row always renders a value, at minimum the idle em-dash",
		check: frame =>
			labeledRows(frame)
				.filter(row => row.value.length === 0)
				.map(row => `${row.label}: value column empty — ${JSON.stringify(row.body)}`),
	},
	{
		id: "missing-dot",
		bead: "daw.1",
		says: "a labeled row always carries a status glyph",
		check: frame =>
			labeledRows(frame)
				.filter(row => row.dot === null)
				.map(row => `${row.label}: no status glyph — ${JSON.stringify(row.body)}`),
	},
	{
		id: "ascii-placeholder",
		bead: "daw.2",
		says: "idle reads as the em-dash the rest of the box uses, never ASCII --",
		check: frame =>
			labeledRows(frame)
				.filter(row => /(^|\s)--(\s|$)/.test(row.value))
				.map(row => `${row.label}: ASCII placeholder — ${JSON.stringify(row.value)}`),
	},
	{
		id: "dead-rate",
		bead: "daw.2",
		says: "a rate row does not advertise a zero peak once the session has streamed",
		check: frame =>
			labeledRows(frame)
				.filter(row => /\bpeak 0\b/.test(row.value))
				.map(row => `${row.label}: ${JSON.stringify(row.value)}`),
	},
	{
		id: "absolute-path",
		bead: "daw.3",
		says: "paths shorten to ~ or a basename; the box is too narrow for /Users/...",
		check: frame =>
			allRows(frame)
				.filter(row => /\/Users\/|\/home\//.test(row.body))
				.map(row => `absolute path — ${JSON.stringify(row.body.slice(0, 90))}`),
	},
	{
		id: "glued-markdown",
		bead: "daw.3",
		says: "prompt text is summarised, not dumped with its newlines stripped",
		check: frame =>
			allRows(frame)
				.filter(row => /\S#{1,6}\s*\w|\w!#|\*\*\w/.test(row.body))
				.map(row => `raw markdown — ${JSON.stringify(row.body.slice(0, 90))}`),
	},
	{
		id: "read-write-collision",
		bead: "daw.7",
		says: "one frame does not use read/write for both cache tokens and file operations",
		check: frame => {
			const text = allRows(frame)
				.map(row => row.body)
				.join("\n");
			const tokens = /[\d.]+[KMG]\s+(read|write)\b/.exec(text);
			// Only the plural/edited forms count as file operations; "0 write" is a cache token count.
			const files = /\b\d+\s+(?:reads|writes|edited)\b/.exec(text);
			if (!tokens || !files) return [];
			return [`${JSON.stringify(tokens[0])} and ${JSON.stringify(files[0])} in one frame`];
		},
	},
	{
		id: "junk-forecast",
		bead: "daw.6",
		says: "a burn-rate forecast past ~99 turns is noise and caps out",
		check: frame =>
			allRows(frame)
				.flatMap(row => [...row.body.matchAll(/~?(\d{3,})\s*turns?\b/g)])
				.map(hit => `forecast ${hit[0]} exceeds the useful ceiling`),
	},
	{
		id: "mixed-separator",
		bead: "daw.8",
		says: "detail items are separated the same way on every row",
		check: frame => {
			const rows = labeledRows(frame);
			if (!rows.some(row => row.value.includes(" · "))) return [];
			return rows
				.filter(row => / [—–-] /.test(row.value))
				.map(row => `${row.label}: dash separator beside the box's middot — ${JSON.stringify(row.value)}`);
		},
	},
	{
		id: "ragged-tail",
		bead: "daw.8",
		says: "wide-only tails share one column so the box reads as a table",
		check: frame =>
			frame.boxes.flatMap(box => {
				const columns = box.rows
					.filter(row => row.kind === "labeled")
					.map(row => tailColumn(row))
					.filter(column => column > 0);
				const distinct = [...new Set(columns)];
				return distinct.length > 1 ? [`tails start at columns ${distinct.join(", ")}`] : [];
			}),
	},
	{
		id: "repeated-chip",
		bead: "daw.4",
		says: "summary chips are not duplicated; each agent may identify its own model",
		check: frame => {
			const seen = new Map<string, number>();
			const duplicates: string[] = [];
			for (const box of frame.boxes) {
				let agents = false;
				for (const row of box.rows) {
					if (row.kind === "header") agents = row.label === "agents";
					else if (row.body.length === 0) agents = false;
					const agentRow = agents && AGENT_ROW.test(row.body);
					const agentDetailRow = agents && AGENT_DETAIL_ROW.test(row.body);
					const model = agentRow ? AGENT_MODEL.exec(row.body) : null;
					const modelStart = model ? model[0].length - (model.groups?.model?.length ?? 0) : -1;
					for (const hit of row.body.matchAll(/\b[\w-]+\/[\w.-]+(?::\w+)?\b/g)) {
						if (hit.index === modelStart) continue;
						if (hit[0] === model?.groups?.model) {
							duplicates.push(`${hit[0]} repeated within agent row`);
						}
						if (agentRow || agentDetailRow) continue;
						seen.set(hit[0], (seen.get(hit[0]) ?? 0) + 1);
					}
				}
			}
			return [
				...duplicates,
				...[...seen].filter(([, count]) => count > 1).map(([chip, count]) => `${chip} repeated ${count} times`),
			];
		},
	},
	{
		id: "duplicate-agent-source",
		bead: "zko.4",
		says: "authoritative agent telemetry suppresses inferred fallback rows",
		check: frame =>
			frame.boxes.flatMap(box => {
				const headerIndex = box.rows.findIndex(row => row.kind === "header" && row.label === "agents");
				if (headerIndex === -1) return [];
				const agentRows = box.rows.slice(headerIndex + 1).filter(row => row.body.length > 0);
				const inferredCount = agentRows.filter(row => row.body.includes("(inferred)")).length;
				const authoritativeCount = agentRows.length - inferredCount;
				return inferredCount > 0 && authoritativeCount > 0
					? [`${authoritativeCount} authoritative and ${inferredCount} inferred agent rows render together`]
					: [];
			}),
	},
	{
		id: "broken-bar",
		bead: "4qn.1",
		says: "a context bar is complete at its configured cell count or absent, never sliced",
		check: frame =>
			allRows(frame)
				.filter(row => row.label === "context" || row.kind === "summary" || /^\S\s+context\s{2,}/u.test(row.body))
				.filter(row => !AGENT_ROW.test(row.body))
				.flatMap(row =>
					[...(row.body.split(" · ", 1)[0] ?? "").matchAll(BAR_RUN)]
						.filter(match => !COMPLETE_BAR.test(match[0]))
						.map(match => `incomplete context bar ${JSON.stringify(match[0])} — ${JSON.stringify(row.body)}`),
				),
	},
	{
		id: "fractional-bar",
		bead: "4qn.2",
		says: "the live context bar uses whole cells, never fallback-prone eighth-block boundaries",
		check: frame =>
			allRows(frame)
				.filter(row => /\[[^\]]*[\u2589-\u258f][^\]]*\]/u.test(row.body))
				.map(row => `fractional boundary glyph — ${JSON.stringify(row.body)}`),
	},
	{
		id: "motion-after-ttl",
		bead: "zko.5.8",
		says: "an expired temporal fact cannot continue producing motion frames",
		check: (_frame, metadata) =>
			metadata?.semanticStage === "expired" && (metadata.motionFrameCount ?? 0) > 0
				? [`${metadata.motionFrameCount} motion frame(s) remain after expiry`]
				: [],
	},
	{
		id: "unproven-directional-connector",
		bead: "zko.5.6",
		says: "every directional connector is backed by an explicit relation",
		check: (_frame, metadata) => {
			const connectorCount = metadata?.directionalConnectorCount ?? 0;
			const relationCount = metadata?.explicitRelationCount ?? 0;
			return connectorCount > relationCount
				? [`${connectorCount - relationCount} directional connector(s) lack explicit relation evidence`]
				: [];
		},
	},
	{
		id: "observed-delta-labeled-write",
		bead: "zko.5.4",
		says: "an observed count delta is never labeled as a confirmed write",
		check: (_frame, metadata) =>
			(metadata?.observedDeltaCount ?? 0) > 0 && (metadata?.writeLabelCount ?? 0) > 0
				? [`${metadata?.writeLabelCount ?? 0} write label(s) over observed deltas`]
				: [],
	},
	{
		id: "stale-observation-erased",
		bead: "zko.5.4",
		says: "a stale poll preserves the bounded last-good observation",
		check: (_frame, metadata) => {
			const staleCount = metadata?.staleObservationCount ?? 0;
			const retainedCount = metadata?.retainedObservationCount ?? 0;
			return staleCount > retainedCount ? [`${staleCount - retainedCount} stale observation(s) erased`] : [];
		},
	},
	{
		id: "color-only-lifecycle",
		bead: "zko.5.8",
		says: "lifecycle meaning has a glyph or text marker independent of color",
		check: (_frame, metadata) => {
			const lifecycleCount = metadata?.lifecycleStateCount ?? 0;
			const markerCount = metadata?.textualLifecycleMarkerCount ?? 0;
			return lifecycleCount > markerCount
				? [`${lifecycleCount - markerCount} lifecycle state(s) communicate through color alone`]
				: [];
		},
	},
	{
		id: "pending-completed-collapse",
		bead: "zko.5.9",
		says: "simultaneous pending and completed lifecycle facts remain distinguishable",
		check: (_frame, metadata) =>
			(metadata?.pendingCount ?? 0) > 0 &&
			(metadata?.completedCount ?? 0) > 0 &&
			(metadata?.distinctLifecycleProjectionCount ?? 0) < 2
				? ["pending and completed facts collapse into one projection"]
				: [],
	},
	{
		id: "private-content",
		bead: "zko.5.4",
		says: "render metadata confirms that no private content field entered the frame",
		check: (_frame, metadata) =>
			(metadata?.privateContentFieldCount ?? 0) > 0
				? [`${metadata?.privateContentFieldCount ?? 0} private content field(s) entered the frame`]
				: [],
	},
	{
		id: "duplicate-source-projection",
		bead: "zko.5.13",
		says: "one authoritative fact has exactly one visible source projection",
		check: (_frame, metadata) =>
			(metadata?.sourceProjectionCount ?? 0) > 1
				? [`one fact renders through ${metadata?.sourceProjectionCount ?? 0} source projections`]
				: [],
	},
	{
		id: "unsupported-placeholder",
		bead: "zko.5.11",
		says: "an unsupported optional capability occupies zero rows",
		check: (_frame, metadata) =>
			metadata?.capability === "unsupported" && (metadata.placeholderRowCount ?? 0) > 0
				? [`${metadata.placeholderRowCount} placeholder row(s) render for an unsupported capability`]
				: [],
	},
	{
		id: "idle-row-leak",
		bead: "zko.5.13",
		says: "an irrelevant optional signal occupies zero height",
		check: (_frame, metadata) =>
			(metadata?.idleOptionalRowCount ?? 0) > 0
				? [`${metadata?.idleOptionalRowCount ?? 0} idle optional row(s) consume height`]
				: [],
	},
	{
		id: "retry-cancel-inference",
		bead: "zko.5.9",
		says: "retry and cancellation states require authoritative evidence",
		check: (_frame, metadata) => {
			const retryCount = metadata?.inferredRetryCount ?? 0;
			const cancellationCount = metadata?.inferredCancellationCount ?? 0;
			return retryCount + cancellationCount > 0
				? [`${retryCount} inferred retry and ${cancellationCount} inferred cancellation state(s)`]
				: [];
		},
	},
	{
		id: "width-overflow",
		bead: "zko.5.20",
		says: "an effect projection stays within its admitted width",
		check: (_frame, metadata) => {
			const contentWidth = metadata?.contentWidth ?? 0;
			const availableWidth = metadata?.availableWidth ?? 0;
			return availableWidth > 0 && contentWidth > availableWidth
				? [`projection is ${contentWidth - availableWidth} column(s) over its admitted width`]
				: [];
		},
	},
	{
		id: "required-row-displacement",
		bead: "zko.5.13",
		says: "optional effects never displace required Audit Box rows",
		check: (frame, metadata) => {
			const requiredCount = metadata?.requiredRowCount ?? 0;
			const renderedCount = frame.boxes.length === 0 ? 0 : (metadata?.renderedRequiredRowCount ?? requiredCount);
			return renderedCount < requiredCount
				? [`${requiredCount - renderedCount} required row(s) were displaced or not captured`]
				: [];
		},
	},
	{
		id: "opaque-repeat-copy",
		bead: "omp-animations-44w",
		says: "repeated tool sequences use plain repeat wording, never internal orbit terminology",
		check: frame =>
			allRows(frame)
				.filter(row => /\borbit\b/i.test(row.body))
				.map(row => `opaque repeat copy — ${JSON.stringify(row.body)}`),
	},
	{
		id: "incomplete-border",
		bead: "omp-animations-mg5",
		says: "an owned Audit Box has both border caps and closed body rows",
		check: frame => frame.boxes.filter(box => !box.completeBorder).map(() => "Audit Box border is incomplete"),
	},
	{
		id: "ragged-width",
		bead: "-",
		says: "every line of a box ends in the same column",
		check: frame =>
			frame.boxes.flatMap(box => {
				const distinct = [...new Set(box.widths.filter(width => width > 0))];
				return distinct.length > 1 ? [`box lines measure ${distinct.join(", ")} columns`] : [];
			}),
	},
];

/** Pure lint seam used by fixtures and replay: callers provide safe counts/enums, never provenance tokens. */
export function lintFrame(file: string, text: string, metadata: Readonly<FrameLintMetadata> = {}): Violation[] {
	return lintParsedFrame(parseFrame(file, text), metadata);
}

function lintParsedFrame(frame: Frame, metadata: Readonly<FrameLintMetadata>): Violation[] {
	const violations: Violation[] = [];
	for (const rule of RULES) {
		for (const evidence of rule.check(frame, metadata)) {
			violations.push({ rule: rule.id, bead: rule.bead, file: frame.file, evidence });
		}
	}
	return violations;
}

async function newestRun(root: string): Promise<string | null> {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	const runs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
	runs.sort();
	const last = runs.at(-1);
	return last ? path.join(root, last) : null;
}

async function collect(targets: string[]): Promise<string[]> {
	const files: string[] = [];
	for (const target of targets) {
		const stat = await fs.stat(target).catch(() => null);
		if (stat === null) continue;
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(target)).sort()) {
				if (name.endsWith(".txt")) files.push(path.join(target, name));
			}
		} else files.push(target);
	}
	return files;
}

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	const json = argv.includes("--json");
	const explicit = argv.filter(arg => !arg.startsWith("--"));
	const targets = explicit.length > 0 ? explicit : [(await newestRun(".frames")) ?? ""].filter(Boolean);
	if (targets.length === 0) {
		process.stderr.write("lint: no frames — run `bun run probe` first\n");
		process.exit(2);
	}

	const files = await collect(targets);
	const violations: Violation[] = [];
	let gradedFrames = 0;
	for (const file of files) {
		const frame = parseFrame(file, await Bun.file(file).text());
		if (frame.boxes.length > 0) gradedFrames++;
		violations.push(...lintParsedFrame(frame, {}));
	}
	const exitCode = violations.length > 0 ? 1 : gradedFrames === 0 ? 2 : 0;

	if (json) {
		process.stdout.write(`${JSON.stringify({ files: files.length, gradedFrames, violations }, null, 2)}\n`);
		process.exit(exitCode);
	}

	const byRule = new Map<string, Violation[]>();
	for (const violation of violations) {
		const bucket = byRule.get(violation.rule) ?? [];
		bucket.push(violation);
		byRule.set(violation.rule, bucket);
	}

	process.stdout.write(`lint: ${files.length} frame(s), ${violations.length} violation(s)\n`);
	if (gradedFrames === 0) process.stderr.write("lint: inconclusive; no identifiable Audit Box frames were graded\n");
	for (const rule of RULES) {
		const hits = byRule.get(rule.id);
		if (!hits) continue;
		process.stdout.write(`\n  ${rule.id} [${rule.bead}] — ${rule.says}\n`);
		const unique = [...new Set(hits.map(hit => hit.evidence))].slice(0, 4);
		for (const evidence of unique) process.stdout.write(`    ${evidence}\n`);
		process.stdout.write(`    seen in ${new Set(hits.map(hit => hit.file)).size} frame(s)\n`);
	}
	process.exit(exitCode);
}

if (import.meta.main) await main();
