export type ActivityRosterDetail = "compact" | "verbose";

export interface ActivityRosterSettings {
	readonly detail: ActivityRosterDetail;
	readonly retentionMs: number;
}

export const ACTIVITY_ROSTER_SETTING_KEYS = {
	detail: "agentRosterDetail",
	retentionSeconds: "animationsBonsaiSettleSeconds",
} as const;

export const ACTIVITY_ROSTER_SETTING_ENV = {
	detail: "OMP_ANIMATIONS_AGENT_ROSTER_DETAIL",
	retentionSeconds: "OMP_ANIMATIONS_BONSAI_SETTLE_SECONDS",
} as const;

export const ACTIVITY_ROSTER_DEFAULTS: ActivityRosterSettings = {
	detail: "compact",
	retentionMs: 300_000,
};

const DETAIL_VALUES: readonly ActivityRosterDetail[] = ["compact", "verbose"];
const MAX_RETENTION_SECONDS = 86_400;

function resolveDetail(raw: unknown): ActivityRosterDetail {
	return typeof raw === "string" && DETAIL_VALUES.includes(raw as ActivityRosterDetail)
		? (raw as ActivityRosterDetail)
		: ACTIVITY_ROSTER_DEFAULTS.detail;
}

function resolveRetentionMs(raw: unknown): number {
	let seconds: number;
	if (typeof raw === "number") seconds = raw;
	else if (typeof raw === "string" && raw.trim() !== "") seconds = Number(raw);
	else return ACTIVITY_ROSTER_DEFAULTS.retentionMs;
	if (!Number.isFinite(seconds)) return ACTIVITY_ROSTER_DEFAULTS.retentionMs;
	return Math.round(Math.min(MAX_RETENTION_SECONDS, Math.max(0, seconds)) * 1_000);
}

export function resolveActivityRosterSettings(
	pluginSettings: Record<string, unknown>,
	env: Record<string, string | undefined> = Bun.env,
): ActivityRosterSettings {
	return {
		detail: resolveDetail(
			pluginSettings[ACTIVITY_ROSTER_SETTING_KEYS.detail] ?? env[ACTIVITY_ROSTER_SETTING_ENV.detail],
		),
		retentionMs: resolveRetentionMs(
			pluginSettings[ACTIVITY_ROSTER_SETTING_KEYS.retentionSeconds] ??
				env[ACTIVITY_ROSTER_SETTING_ENV.retentionSeconds],
		),
	};
}
