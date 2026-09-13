import type { TemporalEvidenceStage } from "../animations-box/temporal-evidence";

export interface EffectRenderOptions {
	readonly width: number;
	readonly unicode?: boolean;
	readonly color?: boolean;
	readonly reducedMotion?: boolean;
}

export interface EffectFrame {
	readonly text: string;
	readonly nextAt?: number;
}

export interface AfterglowPolicy {
	readonly freshMs: number;
	readonly recentMs: number;
	readonly residualMs: number;
}

export interface AfterglowState {
	readonly observedAt: number;
	readonly freshUntil: number;
	readonly recentUntil: number;
	readonly expiresAt: number;
}

export interface AfterglowFrame extends EffectFrame {
	readonly stage: TemporalEvidenceStage;
	readonly glyph: string;
}

export const DEFAULT_AFTERGLOW_POLICY: AfterglowPolicy = {
	freshMs: 240,
	recentMs: 360,
	residualMs: 300,
};

function finiteNonnegative(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function positiveInteger(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	return Math.floor(value);
}

function fitWidth(value: string, width: number, unicode: boolean): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	if (value.length <= columns) return value.padEnd(columns);
	if (columns === 1) return unicode ? "…" : ".";
	return `${value.slice(0, columns - 1)}${unicode ? "…" : "."}`;
}

function stageAt(state: AfterglowState, now: number): TemporalEvidenceStage | undefined {
	if (now >= state.expiresAt) return undefined;
	if (now < state.freshUntil) return "fresh";
	if (now < state.recentUntil) return "recent";
	return "residual";
}

function stageBoundary(state: AfterglowState, stage: TemporalEvidenceStage): number {
	if (stage === "fresh") return state.freshUntil;
	if (stage === "recent") return state.recentUntil;
	return state.expiresAt;
}

/** Retargets to a newer authoritative transition. Duplicate and out-of-order observations coalesce. */
export function retargetAfterglow(
	state: AfterglowState | undefined,
	observedAt: number | undefined,
	policy: AfterglowPolicy = DEFAULT_AFTERGLOW_POLICY,
): AfterglowState | undefined {
	if (observedAt === undefined || !Number.isFinite(observedAt)) return state;
	if (state !== undefined && observedAt <= state.observedAt) return state;
	const freshUntil = observedAt + finiteNonnegative(policy.freshMs);
	const recentUntil = freshUntil + finiteNonnegative(policy.recentMs);
	return {
		observedAt,
		freshUntil,
		recentUntil,
		expiresAt: recentUntil + finiteNonnegative(policy.residualMs),
	};
}

export function freshnessAfterglow(
	state: AfterglowState | undefined,
	now: number,
	options: EffectRenderOptions,
): AfterglowFrame | undefined {
	if (state === undefined || !Number.isFinite(now)) return undefined;
	const stage = stageAt(state, now);
	if (stage === undefined) return undefined;
	const unicode = options.unicode !== false;
	const glyph = options.reducedMotion
		? unicode
			? "•"
			: "*"
		: unicode
			? ({ fresh: "█", recent: "▓", residual: "░" } as const)[stage]
			: ({ fresh: "#", recent: "+", residual: "." } as const)[stage];
	return {
		stage,
		glyph,
		text: fitWidth(`${glyph} ${stage}`, options.width, unicode),
		nextAt: stageBoundary(state, stage),
	};
}

export type ConfidenceRailInput =
	| {
			readonly kind: "measured";
			readonly current: number;
			readonly total: number;
			readonly previousCurrent?: number;
			readonly previousTotal?: number;
	  }
	| {
			readonly kind: "milestone";
			readonly completed: number;
			readonly total: number;
			readonly previousCompleted?: number;
			readonly previousTotal?: number;
	  }
	| {
			readonly kind: "event-only";
			readonly observedAt?: number;
	  };

export type ConfidenceRailDirection = "forward" | "regressed" | "rebased" | "stable";

export type ConfidenceRailFrame =
	| (EffectFrame & {
			readonly kind: "measured";
			readonly ratio: number;
			readonly percent: number;
			readonly direction: ConfidenceRailDirection;
	  })
	| (EffectFrame & {
			readonly kind: "milestone";
			readonly completed: number;
			readonly total: number;
			readonly direction: ConfidenceRailDirection;
	  })
	| (EffectFrame & {
			readonly kind: "event-only";
			readonly recent: boolean;
			readonly stage?: TemporalEvidenceStage;
	  });

function confidenceDirection(
	current: number,
	total: number,
	previousCurrent: number | undefined,
	previousTotal: number | undefined,
): ConfidenceRailDirection {
	if (previousCurrent === undefined || previousTotal === undefined) return "stable";
	if (previousTotal !== total) return "rebased";
	if (current > previousCurrent) return "forward";
	if (current < previousCurrent) return "regressed";
	return "stable";
}

function railCells(width: number): number {
	if (width < 10) return 2;
	if (width < 16) return 4;
	return 6;
}

/** Renders only the confidence supported by the input discriminator. */
export function confidenceRail(
	input: ConfidenceRailInput | undefined,
	now: number,
	options: EffectRenderOptions,
): ConfidenceRailFrame | undefined {
	if (input === undefined || !Number.isFinite(now)) return undefined;
	const unicode = options.unicode !== false;
	const cells = railCells(options.width);

	if (input.kind === "measured") {
		const current = positiveInteger(input.current);
		const total = positiveInteger(input.total);
		if (current === undefined || total === undefined || total === 0) return undefined;
		const ratio = current / total;
		const filled = Math.round(Math.max(0, Math.min(1, ratio)) * cells);
		const rail = `${unicode ? "█" : "#"}`.repeat(filled) + `${unicode ? "░" : "."}`.repeat(cells - filled);
		const percent = Math.round(ratio * 100);
		return {
			kind: "measured",
			ratio,
			percent,
			direction: confidenceDirection(current, total, input.previousCurrent, input.previousTotal),
			text: fitWidth(`[${rail}] ${percent}%`, options.width, unicode),
		};
	}

	if (input.kind === "milestone") {
		const completed = positiveInteger(input.completed);
		const total = positiveInteger(input.total);
		if (completed === undefined || total === undefined || total === 0) return undefined;
		const bounded = Math.min(completed, total);
		const filled = Math.floor((bounded / total) * cells);
		const next = filled < cells ? 1 : 0;
		const rail =
			`${unicode ? "◆" : "#"}`.repeat(filled) +
			`${unicode ? "◇" : "+"}`.repeat(next) +
			".".repeat(cells - filled - next);
		return {
			kind: "milestone",
			completed,
			total,
			direction: confidenceDirection(completed, total, input.previousCompleted, input.previousTotal),
			text: fitWidth(`[${rail}] ${completed}/${total}`, options.width, unicode),
		};
	}

	if (input.observedAt === undefined || !Number.isFinite(input.observedAt)) return undefined;
	const glow = retargetAfterglow(undefined, input.observedAt);
	const stage = glow === undefined ? undefined : stageAt(glow, now);
	const marker = options.reducedMotion ? (unicode ? "•" : "*") : unicode ? "◆" : "*";
	const empty = unicode ? "·" : ".";
	const center = Math.floor(cells / 2);
	const rail = Array.from({ length: cells }, (_, index) =>
		stage !== undefined && index === center ? marker : empty,
	).join("");
	return {
		kind: "event-only",
		recent: stage !== undefined,
		...(stage === undefined ? {} : { stage }),
		text: fitWidth(`[${rail}] ${stage === undefined ? "idle" : "updated"}`, options.width, unicode),
		...(stage === undefined || glow === undefined ? {} : { nextAt: stageBoundary(glow, stage) }),
	};
}

export interface RetryFuseState {
	readonly attempt: number;
	readonly maxAttempts?: number;
	readonly deadline?: number;
	readonly anchorAt: number;
	readonly startFraction: number;
}

export type RetryFuseEvent =
	| {
			readonly type: "schedule";
			readonly at: number;
			readonly attempt: number;
			readonly maxAttempts?: number;
			readonly deadline?: number;
	  }
	| {
			readonly type: "reschedule";
			readonly at: number;
			readonly attempt?: number;
			readonly maxAttempts?: number;
			readonly deadline?: number;
	  }
	| { readonly type: "dispatch" | "cancel" | "terminal"; readonly at: number };

export interface RetryFuseFrame extends EffectFrame {
	readonly attempt: number;
	readonly maxAttempts?: number;
	readonly remainingFraction?: number;
	readonly countOnly: boolean;
}

function retryFraction(state: RetryFuseState, now: number): number | undefined {
	if (state.deadline === undefined) return undefined;
	const duration = state.deadline - state.anchorAt;
	if (duration <= 0 || now >= state.deadline) return 0;
	if (now <= state.anchorAt) return state.startFraction;
	return state.startFraction * ((state.deadline - now) / duration);
}

/** Authoritative retry lifecycle reducer. Dispatch, cancellation, and every terminal edge clear immediately. */
export function reduceRetryFuse(state: RetryFuseState | undefined, event: RetryFuseEvent): RetryFuseState | undefined {
	if (!Number.isFinite(event.at)) return state;
	if (event.type === "dispatch" || event.type === "cancel" || event.type === "terminal") return undefined;
	if (event.type === "schedule") {
		const attempt = positiveInteger(event.attempt);
		if (attempt === undefined) return state;
		const maxAttempts = event.maxAttempts === undefined ? undefined : positiveInteger(event.maxAttempts);
		const deadline = event.deadline !== undefined && Number.isFinite(event.deadline) ? event.deadline : undefined;
		return {
			attempt,
			...(maxAttempts === undefined ? {} : { maxAttempts }),
			...(deadline === undefined ? {} : { deadline }),
			anchorAt: event.at,
			startFraction: 1,
		};
	}
	if (event.type !== "reschedule") return state;
	if (state === undefined || event.at < state.anchorAt) return state;
	const attempt = event.attempt === undefined ? state.attempt : positiveInteger(event.attempt);
	if (attempt === undefined) return state;
	const maxAttempts = event.maxAttempts === undefined ? state.maxAttempts : positiveInteger(event.maxAttempts);
	const previousFraction = retryFraction(state, event.at) ?? 1;
	const deadline = event.deadline !== undefined && Number.isFinite(event.deadline) ? event.deadline : undefined;
	return {
		attempt,
		...(maxAttempts === undefined ? {} : { maxAttempts }),
		...(deadline === undefined ? {} : { deadline }),
		anchorAt: event.at,
		startFraction: previousFraction,
	};
}

export function retryFuse(
	state: RetryFuseState | undefined,
	now: number,
	options: EffectRenderOptions,
): RetryFuseFrame | undefined {
	if (state === undefined || !Number.isFinite(now)) return undefined;
	const unicode = options.unicode !== false;
	const count = state.maxAttempts === undefined ? `retry ${state.attempt}` : `${state.attempt}/${state.maxAttempts}`;
	const remainingFraction = retryFraction(state, now);
	if (remainingFraction === undefined || options.width < 13) {
		return {
			attempt: state.attempt,
			...(state.maxAttempts === undefined ? {} : { maxAttempts: state.maxAttempts }),
			countOnly: true,
			text: fitWidth(count, options.width, unicode),
		};
	}
	const cells = options.width < 20 ? 3 : 5;
	const lit = Math.ceil(Math.max(0, Math.min(1, remainingFraction)) * cells);
	const rail = `${unicode ? "━" : "="}`.repeat(lit) + `${unicode ? "·" : "."}`.repeat(cells - lit);
	const remainingMs = Math.max(0, (state.deadline ?? now) - now);
	// Fractional scheduler timestamps can leave a whole-second deadline just above its boundary.
	const time = options.reducedMotion
		? `${Math.ceil(Math.round(remainingMs) / 1_000)}s`
		: `${(remainingMs / 1_000).toFixed(1)}s`;
	const nextAt =
		remainingMs === 0
			? undefined
			: options.reducedMotion
				? Math.min(state.deadline ?? now, now + Math.min(1_000, remainingMs))
				: Math.min(state.deadline ?? now, now + Math.min(200, remainingMs));
	return {
		attempt: state.attempt,
		...(state.maxAttempts === undefined ? {} : { maxAttempts: state.maxAttempts }),
		remainingFraction,
		countOnly: false,
		text: fitWidth(`${count} [${rail}] ${time}`, options.width, unicode),
		...(nextAt === undefined ? {} : { nextAt }),
	};
}

export type CancellationSweepState =
	| { readonly phase: "stopping"; readonly requestedAt: number }
	| { readonly phase: "acknowledged"; readonly acknowledgedAt: number; readonly expiresAt: number };

export type CancellationSweepEvent =
	| { readonly type: "request"; readonly at: number }
	| { readonly type: "acknowledge"; readonly at: number; readonly exact: boolean }
	| { readonly type: "terminal"; readonly at: number };

export interface CancellationSweepFrame extends EffectFrame {
	readonly phase: "stopping" | "acknowledged";
}

export function reduceCancellationSweep(
	state: CancellationSweepState | undefined,
	event: CancellationSweepEvent,
	durationMs = 600,
): CancellationSweepState | undefined {
	if (!Number.isFinite(event.at)) return state;
	if (event.type === "terminal") return undefined;
	if (event.type === "request") {
		if (state?.phase === "stopping" && event.at <= state.requestedAt) return state;
		return { phase: "stopping", requestedAt: event.at };
	}
	if (!event.exact || state?.phase !== "stopping" || event.at < state.requestedAt) return state;
	return { phase: "acknowledged", acknowledgedAt: event.at, expiresAt: event.at + finiteNonnegative(durationMs) };
}

export function cancellationSweep(
	state: CancellationSweepState | undefined,
	now: number,
	options: EffectRenderOptions,
): CancellationSweepFrame | undefined {
	if (state === undefined || !Number.isFinite(now)) return undefined;
	const unicode = options.unicode !== false;
	if (state.phase === "stopping") {
		return { phase: "stopping", text: fitWidth("stopping", options.width, unicode) };
	}
	if (now >= state.expiresAt) return undefined;
	const duration = Math.max(1, state.expiresAt - state.acknowledgedAt);
	const progress = Math.max(0, Math.min(1, (now - state.acknowledgedAt) / duration));
	const step = options.reducedMotion ? 3 : Math.min(3, Math.floor(progress * 3) + 1);
	const sweep = `${unicode ? "›" : ">"}`.repeat(step).padEnd(3, unicode ? "·" : ".");
	const nextAt = options.reducedMotion
		? state.expiresAt
		: Math.min(state.expiresAt, state.acknowledgedAt + (Math.floor(progress * 3) + 1) * (duration / 3));
	return { phase: "acknowledged", text: fitWidth(`stopped [${sweep}]`, options.width, unicode), nextAt };
}

export interface SkillInvocationNode {
	readonly name: string;
	readonly repeat: number;
	readonly startedAt: number;
	readonly endedAt?: number;
}

export interface SkillInvocationScope {
	readonly actor: string;
	readonly turn: string;
	readonly nodes: readonly SkillInvocationNode[];
	readonly overflow: number;
	readonly current?: string;
	readonly changedAt: number;
}

export interface SkillInvocationState {
	readonly scopes: readonly SkillInvocationScope[];
}

export type SkillInvocationEvent =
	| {
			readonly type: "read-start" | "read-end";
			readonly actor: string;
			readonly turn: string;
			readonly tool: string;
			readonly path: string;
			readonly at: number;
	  }
	| { readonly type: "turn-end"; readonly actor: string; readonly turn: string; readonly at: number }
	| { readonly type: "reset"; readonly at: number };

export interface SkillInvocationFrame extends EffectFrame {
	readonly current?: string;
	readonly latest?: string;
	readonly chain: string;
	readonly overflow: number;
}

export const EMPTY_SKILL_INVOCATIONS: SkillInvocationState = { scopes: [] };

export function rootSkillName(tool: string, path: string): string | undefined {
	if (tool !== "read") return undefined;
	const match = /^skill:\/\/([a-z0-9][a-z0-9._-]{0,63})$/i.exec(path);
	return match?.[1]?.toLowerCase();
}

function updateScope(
	state: SkillInvocationState,
	actor: string,
	turn: string,
	update: (scope: SkillInvocationScope | undefined) => SkillInvocationScope | undefined,
): SkillInvocationState {
	const index = state.scopes.findIndex(scope => scope.actor === actor && scope.turn === turn);
	const current = index < 0 ? undefined : state.scopes[index];
	const next = update(current);
	if (next === current) return state;
	if (next === undefined) return { scopes: state.scopes.filter((_, candidate) => candidate !== index) };
	if (index < 0) return { scopes: [...state.scopes, next] };
	return { scopes: state.scopes.map((scope, candidate) => (candidate === index ? next : scope)) };
}

/** Keeps a bounded, ordered chain per exact actor and turn. Raw read paths never enter retained state. */
export function reduceSkillInvocations(
	state: SkillInvocationState,
	event: SkillInvocationEvent,
	capacity = 4,
): SkillInvocationState {
	if (!Number.isFinite(event.at)) return state;
	if (event.type === "reset") return EMPTY_SKILL_INVOCATIONS;
	if (event.type === "turn-end") return updateScope(state, event.actor, event.turn, () => undefined);
	const skill = rootSkillName(event.tool, event.path);
	if (skill === undefined || event.actor.length === 0 || event.turn.length === 0) return state;
	const boundedCapacity = Math.max(1, Math.floor(capacity));
	return updateScope(state, event.actor, event.turn, scope => {
		if (event.type === "read-end") {
			if (scope === undefined || scope.current !== skill || event.at < scope.changedAt) return scope;
			const last = scope.nodes.at(-1);
			if (last === undefined || last.name !== skill) return scope;
			return {
				...scope,
				nodes: [...scope.nodes.slice(0, -1), { ...last, endedAt: event.at }],
				current: undefined,
				changedAt: event.at,
			};
		}
		if (scope !== undefined && event.at < scope.changedAt) return scope;
		const nodes = scope?.nodes ?? [];
		const last = nodes.at(-1);
		let nextNodes: readonly SkillInvocationNode[];
		let overflow = scope?.overflow ?? 0;
		if (last?.name === skill) {
			nextNodes = [...nodes.slice(0, -1), { name: skill, repeat: last.repeat + 1, startedAt: event.at }];
		} else {
			nextNodes = [...nodes, { name: skill, repeat: 1, startedAt: event.at }];
			if (nextNodes.length > boundedCapacity) {
				nextNodes = nextNodes.slice(nextNodes.length - boundedCapacity);
				overflow++;
			}
		}
		return { actor: event.actor, turn: event.turn, nodes: nextNodes, overflow, current: skill, changedAt: event.at };
	});
}

export function skillInvocationSnapshot(
	state: SkillInvocationState,
	actor: string,
	turn: string,
): SkillInvocationScope | undefined {
	return state.scopes.find(scope => scope.actor === actor && scope.turn === turn);
}

export function skillInvocationChain(
	scope: SkillInvocationScope | undefined,
	now: number,
	options: EffectRenderOptions,
): SkillInvocationFrame | undefined {
	if (scope === undefined || scope.nodes.length === 0 || !Number.isFinite(now)) return undefined;
	const unicode = options.unicode !== false;
	const latest = scope.nodes.at(-1)?.name;
	if (latest === undefined) return undefined;
	const separator = unicode ? " → " : " -> ";
	const chain = [
		...(scope.overflow === 0 ? [] : [`+${scope.overflow}`]),
		...scope.nodes.map(node => `${node.name}${node.repeat > 1 ? `${unicode ? "×" : "x"}${node.repeat}` : ""}`),
	].join(separator);
	const body = `${chain} · ${scope.current === undefined ? "used" : "active"}`;
	return {
		...(scope.current === undefined ? {} : { current: scope.current }),
		latest,
		chain,
		overflow: scope.overflow,
		text: fitWidth(body, options.width, unicode),
	};
}
