import * as path from "node:path";
import type { SegmentSample } from "../animations-box/segments";
import type { PhraseSpan } from "../animations-box/status-line";
import type { LiveFileSnapshot, LiveFilesState } from "./state";

const ACCENT = "syntaxVariable" as const;

function variants(paths: readonly string[]): readonly string[] {
	const full = paths.join(" · ");
	const short = paths.map(filePath => path.basename(filePath)).join(" · ");
	return full === short ? [full] : [full, short];
}

/** Build the Audit Box's current-write row from an immutable activity projection. */
export function buildLiveFilesSnapshotSegment(snapshot: LiveFileSnapshot, priority: number): SegmentSample {
	const paths = [...new Set(snapshot.entries.map(entry => entry.path))];
	if (paths.length === 0) {
		return {
			id: "filesLive",
			priority,
			active: false,
			variants: [],
			line: {
				dot: "idle",
				label: "files",
				accent: ACCENT,
				spans: [{ key: "idle", text: "—", tone: "dim" }],
			},
		};
	}

	const colliding = new Set(snapshot.collidingPaths);
	const spans: PhraseSpan[] = paths.map((filePath, index) => {
		const span: PhraseSpan = { key: `path-${index}`, text: filePath, priority: index };
		return colliding.has(filePath) ? { ...span, tone: "alert" } : span;
	});
	if (colliding.size > 0) {
		// Distinct writers on the worst colliding path; the producer derives
		// `collidingPaths` from these same entries, so this is never below 2.
		const ownersByPath = new Map<string, Set<string>>();
		for (const entry of snapshot.entries) {
			if (!colliding.has(entry.path)) continue;
			const owners = ownersByPath.get(entry.path);
			if (owners === undefined) ownersByPath.set(entry.path, new Set([entry.owner]));
			else owners.add(entry.owner);
		}
		let writers = 0;
		for (const owners of ownersByPath.values()) writers = Math.max(writers, owners.size);
		spans.push({ key: "clash", text: `${writers} writers` });
	}

	return {
		id: "filesLive",
		priority,
		active: true,
		variants: variants(paths),
		line: { dot: colliding.size > 0 ? "alert" : "live", label: "files", accent: ACCENT, spans },
	};
}

/** Build the Audit Box's current-write row from its legacy event-backed state. */
export function buildLiveFilesSegment(state: LiveFilesState, priority: number): SegmentSample {
	return buildLiveFilesSnapshotSegment(state.snapshot(), priority);
}
