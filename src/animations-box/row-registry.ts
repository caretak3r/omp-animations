/**
 * Core Audit Box row registry.
 *
 * An exhaustive `Record<BoxSegmentId, CoreRowSpec>` makes adding a row a
 * compile-time contract: the compiler walks the author through metadata,
 * optional enablement, and the build lambda. The registry isolates heterogeneous
 * builder signatures; the controller builds one deps object per frame and loops
 * `CORE_ROW_ORDER`.
 */

import type { ActivityRosterSnapshot } from "../activity-roster/bus";
import { buildActivityFilesSegment } from "../activity-roster/projection";
import type { AuditLedgerState } from "../audit-trail-box";
import type { CacheMeterState } from "../cache-meter";
import type { SymbolPreset } from "../host/types";
import type { LiveFileSnapshot } from "../live-files";
import type { ProviderHealthSnapshot, RateLimitTidepoolState } from "../rate-limit-tidepool";
import type { SignalExtrasConfig } from "../signal-extras";
import type { ContextGaugeState } from "./context-gauge";
import {
	AUDIT_TRAIL_SEGMENT,
	type BoxTheme,
	buildAuditTrailBoxSegment,
	buildCacheMeterSegment,
	buildContextGaugeSegment,
	buildRateLimitTidepoolSegment,
	buildToolActivitySegment,
	CACHE_METER_SEGMENT,
	CONTEXT_GAUGE_SEGMENT,
	LIVE_FILES_SEGMENT,
	RATE_LIMIT_TIDEPOOL_SEGMENT,
	type SegmentSample,
	TOOL_ACTIVITY_SEGMENT,
} from "./segments";
import { BOX_REQUIRED_SEGMENT_IDS, type BoxSegmentId } from "./settings";
import type { ToolActivityState } from "./tool-activity";

/** Everything a core row may read, built once per frame. */
export interface CoreRowDeps {
	readonly now: number;
	readonly theme: BoxTheme;
	readonly glyphPreset: SymbolPreset;
	readonly contextGauge: ContextGaugeState;
	readonly cacheMeter: CacheMeterState;
	readonly auditTrail: AuditLedgerState;
	readonly tidepool: RateLimitTidepoolState;
	readonly providerHealth: ProviderHealthSnapshot | undefined;
	readonly toolActivity: ToolActivityState;
	readonly roster: ActivityRosterSnapshot | undefined;
	readonly liveFiles: LiveFileSnapshot;
	readonly extrasConfig: SignalExtrasConfig;
}

export interface CoreRowSpec {
	readonly meta: { readonly id: BoxSegmentId; readonly label: string; readonly description: string };
	/** Absent = always rendered (required rows). */
	readonly enabled?: (deps: CoreRowDeps) => boolean;
	readonly build: (deps: CoreRowDeps) => SegmentSample;
}

export const CORE_ROW_ORDER: readonly BoxSegmentId[] = BOX_REQUIRED_SEGMENT_IDS;

const FILES_ROW_INDEX = CORE_ROW_ORDER.indexOf("filesLive") + 1;

/** Exhaustive: adding a BoxSegmentId without a spec is a compile error. */
export const CORE_ROWS: Readonly<Record<BoxSegmentId, CoreRowSpec>> = {
	contextGauge: {
		meta: CONTEXT_GAUGE_SEGMENT,
		build: d => buildContextGaugeSegment(d.contextGauge, d.now, d.theme, d.glyphPreset),
	},
	cacheMeter: {
		meta: CACHE_METER_SEGMENT,
		build: d => buildCacheMeterSegment(d.cacheMeter, d.now, d.theme, undefined, d.glyphPreset),
	},
	auditTrailBox: {
		meta: AUDIT_TRAIL_SEGMENT,
		build: d => buildAuditTrailBoxSegment(d.auditTrail, d.now, d.theme, undefined, d.glyphPreset),
	},
	rateLimitTidepool: {
		meta: RATE_LIMIT_TIDEPOOL_SEGMENT,
		build: d => buildRateLimitTidepoolSegment(d.tidepool, d.now, d.theme, undefined, d.glyphPreset, d.providerHealth),
	},
	toolActivity: {
		meta: TOOL_ACTIVITY_SEGMENT,
		build: d => buildToolActivitySegment(d.toolActivity, d.now, d.theme, d.glyphPreset),
	},
	filesLive: {
		meta: LIVE_FILES_SEGMENT,
		enabled: d => d.extrasConfig.liveFiles,
		build: d => buildActivityFilesSegment(d.roster, d.liveFiles, FILES_ROW_INDEX),
	},
};
