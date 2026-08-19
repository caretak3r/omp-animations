import type { FrameScheduler } from "../kit";
import { DEFAULT_FRAME_SCHEDULER } from "../kit";
import { createFileProbeSource, DiskProbe, type ProbeSource } from "./probe";
import { buildRemedyPlan, type RemedyOptions, type RemedyPlan } from "./remedy";
import { AuditLedgerState, type TouchObservation } from "./state";

/** Minimum gap between disk-divergence probe ticks. */
export const PROBE_INTERVAL_MS = 5_000;

export interface AuditTrailServiceOptions {
	scheduler?: FrameScheduler;
	probeSource?: ProbeSource;
	probeIntervalMs?: number;
	probeBatchSize?: number;
	state?: AuditLedgerState;
	onChange?: () => void;
}

/**
 * Sole owner of the audit ledger, divergence probe, and remedy path. The Audit
 * Box reads the same injected {@link AuditLedgerState} to draw its row and never
 * receives a second copy of the audit events.
 */
export class AuditTrailService {
	readonly state: AuditLedgerState;
	readonly scheduler: FrameScheduler;
	#probe: DiskProbe;
	#probeIntervalMs: number;
	#probeInFlight = false;
	#lastProbeMs = Number.NEGATIVE_INFINITY;
	#pendingProbe: Promise<void> = Promise.resolve();
	#onChange: () => void;

	constructor(options: AuditTrailServiceOptions = {}) {
		this.scheduler = options.scheduler ?? DEFAULT_FRAME_SCHEDULER;
		this.state = options.state ?? new AuditLedgerState();
		this.#probe = new DiskProbe(options.probeSource ?? createFileProbeSource(), {
			batchSize: options.probeBatchSize,
		});
		this.#probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS;
		this.#onChange = options.onChange ?? (() => {});
	}

	async settled(): Promise<void> {
		await this.#pendingProbe;
	}

	noteRead(path: string, observed: TouchObservation): void {
		this.state.noteRead(path, observed);
		this.#changed();
		this.#maybeProbe();
	}

	noteWrite(path: string, observed: TouchObservation): void {
		this.state.noteWrite(path, this.scheduler.now(), observed);
		this.#changed();
		this.#maybeProbe();
	}

	noteTurn(): void {
		this.state.noteTurn();
		this.#changed();
		this.#maybeProbe();
	}

	noteRecovery(): void {
		this.state.noteRecovery(this.scheduler.now());
		this.#changed();
	}

	noteSessionSwitch(): void {
		this.state.noteSessionSwitch();
		this.#changed();
	}

	async probeNow(): Promise<void> {
		if (this.#probeInFlight) return;
		const paths = this.state.snapshot().paths.map(record => record.path);
		if (paths.length === 0) return;
		this.#probeInFlight = true;
		this.#lastProbeMs = this.scheduler.now();
		try {
			const readings = await this.#probe.tick(paths);
			this.state.noteProbe(readings, this.scheduler.now());
		} finally {
			this.#probeInFlight = false;
		}
		this.#changed();
	}

	async remedy(options: RemedyOptions = {}): Promise<RemedyPlan> {
		const stale = this.state
			.snapshot()
			.paths.filter(record => record.status === "poisoned" || record.status === "dirty")
			.map(record => record.path);
		if (stale.length > 0) {
			const readings = await this.#probe.probe(stale);
			this.state.noteProbe(readings, this.scheduler.now());
			this.#changed();
		}
		return buildRemedyPlan(this.state.snapshot(), options);
	}

	#changed(): void {
		this.#onChange();
	}

	#maybeProbe(): void {
		if (this.#probeInFlight) return;
		if (this.scheduler.now() - this.#lastProbeMs < this.#probeIntervalMs) return;
		this.#pendingProbe = this.probeNow().catch(() => {});
	}
}
