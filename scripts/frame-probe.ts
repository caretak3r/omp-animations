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
	const shot = await $`tmux capture-pane -p -t ${session}`.quiet().nothrow();
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
	const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const dir = path.join(opts.out, `run-${runId}`);
	await fs.mkdir(dir, { recursive: true });

	const started = Date.now();
	let kept = 0;
	let last = "";
	process.stderr.write(`probe: session=${opts.session} -> ${dir}\n`);

	for (;;) {
		const pane = await capturePane(opts.session);
		if (pane === null) {
			process.stderr.write(`probe: no tmux session '${opts.session}'\n`);
			process.exit(1);
		}
		const boxes = extractBoxes(pane);
		if (boxes.length > 0) {
			const frame = boxes.join("\n\n");
			if (frame !== last) {
				last = frame;
				const elapsed = String(Date.now() - started).padStart(7, "0");
				const name = `f${String(++kept).padStart(4, "0")}-t${elapsed}.txt`;
				await Bun.write(path.join(dir, name), `${frame}\n`);
				process.stderr.write(`probe: ${name} (${boxes.length} box)\n`);
			}
		}
		if (opts.once) break;
		if (opts.duration > 0 && Date.now() - started >= opts.duration * 1000) break;
		await Bun.sleep(opts.interval * 1000);
	}

	process.stderr.write(`probe: ${kept} distinct frame(s) in ${dir}\n`);
	if (kept === 0) process.exit(2);
	process.stdout.write(`${dir}\n`);
}

if (import.meta.main) await main();
