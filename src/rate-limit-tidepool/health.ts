/** Provider-agnostic response health, read off `after_provider_response.status`. */
export type StatusClass = "ok" | "auth" | "throttle" | "server" | "other";

export interface ProviderHealthSnapshot {
	readonly okCount: number;
	readonly lastStatus: number;
	/** Non-2xx counts per class this session; empty when all responses were 2xx. */
	readonly troubleCounts: Readonly<Partial<Record<Exclude<StatusClass, "ok">, number>>>;
	/** Newest non-2xx: its status and when it was observed (controller clock). */
	readonly lastTrouble: { readonly status: number; readonly observedAtMs: number } | undefined;
}

/**
 * Accumulates provider response health from `after_provider_response.status`.
 * Provider-agnostic, never interprets headers or fabricates telemetry — states
 * only "the provider said 429", never a quota percentage or predicted reset.
 */
export class ProviderHealthState {
	#okCount = 0;
	#troubleCounts: Partial<Record<Exclude<StatusClass, "ok">, number>> = {};
	#lastStatus: number | undefined;
	#lastTrouble: { status: number; observedAtMs: number } | undefined;

	/** Classify and accumulate a response status. */
	noteStatus(status: number, nowMs: number): void {
		this.#lastStatus = status;
		const cls = classifyStatus(status);
		if (cls === "ok") {
			this.#okCount++;
		} else {
			this.#troubleCounts[cls] = (this.#troubleCounts[cls] ?? 0) + 1;
			this.#lastTrouble = { status, observedAtMs: nowMs };
		}
	}

	/** `undefined` before the first response — the idle-row cue. */
	snapshot(): ProviderHealthSnapshot | undefined {
		if (this.#lastStatus === undefined) return undefined;
		return {
			okCount: this.#okCount,
			lastStatus: this.#lastStatus,
			troubleCounts: { ...this.#troubleCounts },
			lastTrouble: this.#lastTrouble,
		};
	}

	/** Clear accumulated state on session switch. */
	reset(): void {
		this.#okCount = 0;
		this.#troubleCounts = {};
		this.#lastStatus = undefined;
		this.#lastTrouble = undefined;
	}
}

/**
 * Mechanical classification, never interpreted:
 * 2xx/3xx → ok, 401/403 → auth, 408/429 → throttle, 5xx → server, else other.
 */
export function classifyStatus(status: number): StatusClass {
	if (status >= 200 && status < 400) return "ok";
	if (status === 401 || status === 403) return "auth";
	if (status === 408 || status === 429) return "throttle";
	if (status >= 500 && status < 600) return "server";
	return "other";
}
