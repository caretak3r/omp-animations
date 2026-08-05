/**
 * Audit Trail Box — the active disk-divergence probe.
 *
 * The whole point is that this reads the filesystem *off-path* from the agent's
 * own reads: if divergence were only noticed the next time the agent happened to
 * open a file, the tracker would learn about poisoning at exactly the moment it
 * stops mattering. So the probe walks the tracked working set on its own clock.
 *
 * Two bounds keep that honest. Each tick inspects a round-robin slice rather
 * than the whole set, so a 40-path working set costs a handful of reads per tick
 * instead of 40. And a file past {@link MAX_PROBE_CONTENT_BYTES} is identified by
 * its stat signature rather than its bytes — divergence is still detected, the
 * remedy just has no content to diff, which beats pulling a megabyte into memory
 * on a frame tick.
 *
 * Everything the filesystem touches sits behind {@link ProbeSource} so the
 * scheduling logic is testable without a disk.
 */
import type { ProbeReading } from "./state";

/** Paths inspected per tick. The set is walked round-robin, so every path is still visited — just not all at once. */
export const PROBE_BATCH_SIZE = 6;

/** Files larger than this are identified by stat signature instead of content hash. */
export const MAX_PROBE_CONTENT_BYTES = 128 * 1024;

/** What one inspection found: an identity to compare, and the bytes when they were cheap enough to take. */
export interface ProbeObservation {
	readonly hash: string;
	readonly content?: string;
}

/** The filesystem seam. `undefined` means unreachable — deleted, EPERM, a directory, anything the probe cannot read. */
export interface ProbeSource {
	inspect(path: string): Promise<ProbeObservation | undefined>;
}

/**
 * Stable content identity. Not cryptographic — this compares a file against its
 * own past, nothing adversarial.
 *
 * Trailing newlines are normalized away because the two sides being compared do
 * not agree on them: the probe hashes the file's exact bytes, while the agent's
 * side hashes what the `read` tool handed the model, which is line-joined and
 * loses the final newline. Without this, every ordinary read of a
 * newline-terminated file would look like external divergence — the loudest
 * possible false positive. A whitespace-only tail change is also precisely what
 * a formatter does, so ignoring it costs no real signal.
 */
export function hashContent(text: string): string {
	return Bun.hash(text.replace(/(\r?\n)+$/, "")).toString(36);
}

/**
 * The real filesystem source. Every failure mode collapses to `undefined`
 * (unreachable) on purpose: the tracker's job is to notice that its copy can no
 * longer be trusted, and "the file is gone" and "the file is unreadable" call
 * for the same remedy.
 */
export function createFileProbeSource(maxContentBytes: number = MAX_PROBE_CONTENT_BYTES): ProbeSource {
	return {
		async inspect(path: string): Promise<ProbeObservation | undefined> {
			try {
				const file = Bun.file(path);
				if (file.size > maxContentBytes) return { hash: `stat:${file.size}:${file.lastModified}` };
				const text = await file.text();
				return { hash: hashContent(text), content: text };
			} catch {
				return undefined;
			}
		},
	};
}

export interface DiskProbeOptions {
	/** Paths inspected per tick. Defaults to {@link PROBE_BATCH_SIZE}. */
	readonly batchSize?: number;
}

/**
 * Round-robin scheduler over the tracked working set. Holds only a cursor —
 * the path list is supplied per tick by the caller, so paths appearing and
 * disappearing between ticks needs no reconciliation here.
 */
export class DiskProbe {
	#source: ProbeSource;
	#batchSize: number;
	#cursor = 0;

	constructor(source: ProbeSource, options: DiskProbeOptions = {}) {
		this.#source = source;
		this.#batchSize = Math.max(1, options.batchSize ?? PROBE_BATCH_SIZE);
	}

	/** Where the next tick will resume. Exposed for tests and debugging. */
	get cursor(): number {
		return this.#cursor;
	}

	/** The slice this tick covers, advancing the cursor. Never returns a path twice in one tick. */
	select(paths: readonly string[]): readonly string[] {
		if (paths.length === 0) {
			this.#cursor = 0;
			return [];
		}

		const take = Math.min(this.#batchSize, paths.length);
		const picked: string[] = [];
		let index = this.#cursor % paths.length;
		for (let count = 0; count < take; count++) {
			const path = paths[index];
			if (path !== undefined) picked.push(path);
			index = (index + 1) % paths.length;
		}

		this.#cursor = index;
		return picked;
	}

	/**
	 * Inspect exactly these paths, ignoring the round-robin cursor. This is what
	 * the remedy uses: "re-read every poisoned path before the agent's next touch"
	 * cannot wait for the cursor to come around to them.
	 */
	async probe(paths: readonly string[]): Promise<readonly ProbeReading[]> {
		return Promise.all(
			paths.map(async (path): Promise<ProbeReading> => {
				const observed = await this.#source.inspect(path);
				if (observed === undefined) return { path, hash: undefined, reachable: false };
				return { path, hash: observed.hash, content: observed.content, reachable: true };
			}),
		);
	}

	/** Inspect this tick's slice. Feed the result straight to `AuditLedgerState.noteProbe`. */
	async tick(paths: readonly string[]): Promise<readonly ProbeReading[]> {
		return this.probe(this.select(paths));
	}
}
