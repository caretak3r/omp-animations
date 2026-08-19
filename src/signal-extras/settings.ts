import { animationsEnvKey } from "../appearance";

export const SIGNAL_EXTRA_IDS = [
	"liveFiles",
	"recurrenceStrip",
	"contextRewriteShadow",
	"compactionScar",
	"consentLock",
	"sessionPhylogeny",
	"thinkActLissajous",
	"errorIsotope",
	"queueFog",
	"skillChromatograph",
	"retryRadar",
	"goalHeading",
	"ttftSplit",
	"memoryBackendTide",
	"darkroomTitle",
] as const;

export type SignalExtraId = (typeof SIGNAL_EXTRA_IDS)[number];
export type SignalExtrasConfig = Readonly<Record<SignalExtraId, boolean>>;
export const DEFAULT_SIGNAL_EXTRAS_CONFIG = {
	liveFiles: true,
	recurrenceStrip: true,
	contextRewriteShadow: true,
	compactionScar: true,
	consentLock: true,
	sessionPhylogeny: true,
	thinkActLissajous: true,
	errorIsotope: true,
	queueFog: true,
	skillChromatograph: true,
	retryRadar: true,
	goalHeading: true,
	ttftSplit: true,
	memoryBackendTide: true,
	darkroomTitle: true,
} satisfies SignalExtrasConfig;

function resolveBoolean(raw: unknown, fallback: boolean): boolean {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return fallback;
}

/** Every extra is opt-out: absent and malformed values preserve the curated enabled default. */
export function resolveSignalExtrasConfig(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
): SignalExtrasConfig {
	const resolved = {} as Record<SignalExtraId, boolean>;
	for (const id of SIGNAL_EXTRA_IDS) {
		resolved[id] = resolveBoolean(pluginSettings[id] ?? env[animationsEnvKey(id)], true);
	}
	return resolved;
}
