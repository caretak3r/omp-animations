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

const BORDERED = /^\s*[│┃|](?<body>.*)[│┃|]\s*$/u;
const DOT = /^(?<dot>[○◐●◆◇•▪])\s+(?<rest>.*)$/u;
const TREE = /^[\s│]*[├└╰┌┬─]/u;
const LABEL = /^(?<label>\S+)(?:\s{2,}(?<value>.*))?$/u;

interface Row {
	line: string;
	kind: "labeled" | "tree" | "header" | "other";
	dot: string | null;
	label: string;
	value: string;
	body: string;
}

interface Box {
	rows: Row[];
	widths: number[];
}

interface Frame {
	file: string;
	boxes: Box[];
	text: string;
}

interface Violation {
	rule: string;
	bead: string;
	file: string;
	evidence: string;
}

interface Rule {
	id: string;
	bead: string;
	says: string;
	check: (frame: Frame) => string[];
}

function parseRow(line: string): Row {
	const bordered = BORDERED.exec(line);
	const body = (bordered?.groups?.body ?? line).trim();
	const dotted = DOT.exec(body);
	const dot = dotted?.groups?.dot ?? null;
	const rest = dotted?.groups?.rest ?? body;
	if (TREE.test(body)) return { line, kind: "tree", dot, label: "", value: rest, body };
	const labeled = LABEL.exec(rest);
	// A lone word with no glyph and no value is a group heading ("agents"), not a data row.
	if (dot === null && /^\S+$/.test(rest)) return { line, kind: "header", dot, label: rest, value: "", body };
	if (bordered && labeled && rest.length > 0) {
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
	let rows: Row[] = [];
	let widths: number[] = [];
	for (const line of text.split("\n")) {
		if (/^\s*[╭┌]/.test(line)) {
			rows = [];
			widths = [Bun.stringWidth(line.trimEnd())];
			continue;
		}
		if (widths.length === 0) continue;
		widths.push(Bun.stringWidth(line.trimEnd()));
		if (/^\s*[╰└]/.test(line)) {
			boxes.push({ rows, widths });
			widths = [];
			continue;
		}
		rows.push(parseRow(line));
	}
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
			const tokens = /[\d.]+[KMG]\s+(read|write)\b/.exec(frame.text);
			// Only the plural/edited forms count as file operations; "0 write" is a cache token count.
			const files = /\b\d+\s+(?:reads|writes|edited)\b/.exec(frame.text);
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
		says: "a value identical on every row is a header, not per-row detail",
		check: frame => {
			const seen = new Map<string, number>();
			for (const row of allRows(frame)) {
				for (const hit of row.body.matchAll(/\b[\w-]+\/[\w.-]+(?::\w+)?\b/g)) {
					seen.set(hit[0], (seen.get(hit[0]) ?? 0) + 1);
				}
			}
			return [...seen].filter(([, count]) => count > 1).map(([chip, count]) => `${chip} repeated on ${count} rows`);
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
		id: "fractional-bar",
		bead: "4qn.2",
		says: "the live context bar uses whole cells, never fallback-prone eighth-block boundaries",
		check: frame =>
			allRows(frame)
				.filter(row => /\[[^\]]*[\u2589-\u258f][^\]]*\]/u.test(row.body))
				.map(row => `fractional boundary glyph — ${JSON.stringify(row.body)}`),
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
	for (const file of files) {
		const frame = parseFrame(file, await Bun.file(file).text());
		for (const rule of RULES) {
			for (const evidence of rule.check(frame)) {
				violations.push({ rule: rule.id, bead: rule.bead, file, evidence });
			}
		}
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ files: files.length, violations }, null, 2)}\n`);
		process.exit(violations.length > 0 ? 1 : 0);
	}

	const byRule = new Map<string, Violation[]>();
	for (const violation of violations) {
		const bucket = byRule.get(violation.rule) ?? [];
		bucket.push(violation);
		byRule.set(violation.rule, bucket);
	}

	process.stdout.write(`lint: ${files.length} frame(s), ${violations.length} violation(s)\n`);
	for (const rule of RULES) {
		const hits = byRule.get(rule.id);
		if (!hits) continue;
		process.stdout.write(`\n  ${rule.id} [${rule.bead}] — ${rule.says}\n`);
		const unique = [...new Set(hits.map(hit => hit.evidence))].slice(0, 4);
		for (const evidence of unique) process.stdout.write(`    ${evidence}\n`);
		process.stdout.write(`    seen in ${new Set(hits.map(hit => hit.file)).size} frame(s)\n`);
	}
	process.exit(violations.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
