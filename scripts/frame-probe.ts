#!/usr/bin/env bun
/**
 * Samples the Audit Box out of a live tmux pane so a run can be graded after the fact.
 *
 * The box is only interesting while the session is busy — tools firing, subagents
 * alive, cache warming — so this snapshots on an interval and keeps every frame that
 * differs from the one before it. Idle-only captures hide exactly the bugs we chase.
 *
 *   bun run probe -- --session omp-anim --interval 2
 *   bun run probe -- --once
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const TOP = /^\s*[╭┌]/;
const BOTTOM = /^\s*[╰└]/;
const CAPTURE_FORMAT =
	"@@omp-frame sync=#{synchronized_output_flag} x=#{cursor_x} y=#{cursor_y} width=#{pane_width} height=#{pane_height}";
const CAPTURE_STATE = /^@@omp-frame sync=([01]) x=\d+ y=\d+ width=\d+ height=\d+$/;

export interface PaneCapture {
	pane: string;
	status: "settled" | "in-flight" | "unknown";
	before: string;
	after: string;
}

export function parseCapture(raw: string): PaneCapture {
	const lines = raw.trimEnd().split("\n");
	const before = lines.shift() ?? "";
	const after = lines.pop() ?? "";
	const first = CAPTURE_STATE.exec(before);
	const last = CAPTURE_STATE.exec(after);
	const status =
		!first || !last
			? "unknown"
			: first[1] === "1" || last[1] === "1"
				? "in-flight"
				: before === after
					? "settled"
					: "unknown";
	return { pane: lines.join("\n"), status, before, after };
}

interface ProbeOptions {
	session: string;
	interval: number;
	duration: number;
	out: string;
	once: boolean;
}

function parseArgs(argv: string[]): ProbeOptions {
	const flag = (name: string): string | undefined => {
		const at = argv.indexOf(`--${name}`);
		return at === -1 ? undefined : argv[at + 1];
	};
	return {
		session: flag("session") ?? "omp-anim",
		interval: Number(flag("interval") ?? 2),
		duration: Number(flag("duration") ?? 0),
		out: flag("out") ?? ".frames",
		once: argv.includes("--once"),
	};
}

async function capturePane(session: string): Promise<string | null> {
	const shot =
		await $`tmux display-message -p -t ${session} ${CAPTURE_FORMAT} ${";"} capture-pane -p -t ${session} ${";"} display-message -p -t ${session} ${CAPTURE_FORMAT}`
			.quiet()
			.nothrow();
	return shot.exitCode === 0 ? shot.text() : null;
}

/** Every complete box in the pane, in order, as raw line blocks. */
export function extractBoxes(pane: string): string[] {
	const boxes: string[] = [];
	let open: string[] | null = null;
	for (const line of pane.split("\n")) {
		if (TOP.test(line)) {
			open = [line];
			continue;
		}
		if (open === null) continue;
		open.push(line);
		if (BOTTOM.test(line)) {
			boxes.push(open.join("\n"));
			open = null;
		}
	}
	return boxes;
}

async function main(): Promise<void> {
	const opts = parseArgs(Bun.argv.slice(2));
	const runId = new Date().toISOString().replace(/[:.]/g, "-");
	await fs.mkdir(opts.out, { recursive: true });
	const dir = await fs.mkdtemp(path.join(opts.out, `run-${runId}-`));

	const started = Date.now();
	let kept = 0;
	let inFlight = 0;
	let unknown = 0;
	let last = "";
	const evidence = await fs.open(path.join(dir, "captures.jsonl"), "w");
	process.stderr.write(`probe: session=${opts.session} -> ${dir}\n`);

	try {
		for (;;) {
			const raw = await capturePane(opts.session);
			if (raw === null) {
				process.stderr.write(`probe: capture failed for tmux target '${opts.session}'\n`);
				process.exitCode = 1;
				return;
			}
			const capture = parseCapture(raw);
			const elapsedMs = Date.now() - started;
			await evidence.write(
				`${JSON.stringify({ elapsedMs, status: capture.status, before: capture.before, after: capture.after, raw })}\n`,
			);
			if (capture.status === "in-flight") inFlight++;
			else if (capture.status === "unknown") unknown++;
			else {
				const boxes = extractBoxes(capture.pane);
				if (boxes.length > 0) {
					const frame = boxes.join("\n\n");
					if (frame !== last) {
						last = frame;
						const elapsed = String(elapsedMs).padStart(7, "0");
						const name = `f${String(++kept).padStart(4, "0")}-t${elapsed}.txt`;
						await Bun.write(path.join(dir, name), `${frame}\n`);
						process.stderr.write(`probe: ${name} (${boxes.length} box)\n`);
					}
				}
			}
			if (opts.once) break;
			if (opts.duration > 0 && Date.now() - started >= opts.duration * 1000) break;
			await Bun.sleep(opts.interval * 1000);
		}
	} finally {
		await evidence.close();
	}

	process.stderr.write(
		`probe: ${kept} distinct settled frame(s); ${inFlight} in-flight, ${unknown} unknown capture(s) retained in ${dir}/captures.jsonl\n`,
	);
	if (kept === 0 || unknown > 0) process.exitCode = 2;
	process.stdout.write(`${dir}\n`);
}

if (import.meta.main) await main();
