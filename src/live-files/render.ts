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

	const spans: PhraseSpan[] = paths.map((filePath, index) => ({
		key: `path-${index}`,
		text: filePath,
		priority: index,
	}));
	return {
		id: "filesLive",
		priority,
		active: true,
		variants: variants(paths),
		line: { dot: "live", label: "files", accent: ACCENT, spans },
	};
}

/** Build the Audit Box's current-write row from its legacy event-backed state. */
export function buildLiveFilesSegment(state: LiveFilesState, priority: number): SegmentSample {
	return buildLiveFilesSnapshotSegment(state.snapshot(), priority);
}
