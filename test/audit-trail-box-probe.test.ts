import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFileProbeSource,
	DiskProbe,
	hashContent,
	type ProbeObservation,
	type ProbeSource,
} from "../src/audit-trail-box/probe";
import { AuditLedgerState, POISON_STREAK_TICKS } from "../src/audit-trail-box/state";

/** In-memory filesystem stand-in: a path absent from the map reads as unreachable. */
function fakeSource(files: Map<string, string>): ProbeSource & { inspected: string[] } {
	const inspected: string[] = [];
	return {
		inspected,
		async inspect(path: string): Promise<ProbeObservation | undefined> {
			inspected.push(path);
			const content = files.get(path);
			return content === undefined ? undefined : { hash: hashContent(content), content };
		},
	};
}

describe("audit-trail-box content hashing", () => {
	it("is stable for identical content", () => {
		expect(hashContent("alpha\nbeta\n")).toBe(hashContent("alpha\nbeta\n"));
	});

	it("changes when a single byte changes", () => {
		expect(hashContent("alpha\nbeta\n")).not.toBe(hashContent("alpha\nbetb\n"));
	});

	it("handles empty content without throwing", () => {
		expect(hashContent("")).toBe(hashContent(""));
	});
});

describe("audit-trail-box probe scheduling", () => {
	it("covers the whole set across ticks instead of all of it at once", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 2 });
		const paths = ["a", "b", "c", "d"];

		expect(probe.select(paths)).toEqual(["a", "b"]);
		expect(probe.select(paths)).toEqual(["c", "d"]);
		expect(probe.select(paths)).toEqual(["a", "b"]);
	});

	it("wraps around the end of the set mid-batch", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 2 });
		const paths = ["a", "b", "c"];

		probe.select(paths);
		expect(probe.select(paths)).toEqual(["c", "a"]);
	});

	it("never repeats a path within one tick", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 10 });

		const selected = probe.select(["a", "b", "c"]);

		expect(selected).toEqual(["a", "b", "c"]);
		expect(new Set(selected).size).toBe(selected.length);
	});

	it("resets the cursor when the working set empties", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 2 });
		probe.select(["a", "b", "c"]);

		expect(probe.select([])).toEqual([]);
		expect(probe.cursor).toBe(0);
	});

	it("stays in range when the working set shrinks between ticks", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 2 });
		probe.select(["a", "b", "c", "d", "e"]);
		probe.select(["a", "b", "c", "d", "e"]);

		expect(probe.select(["a", "b"])).toEqual(["a", "b"]);
	});

	it("refuses a zero batch size rather than probing nothing forever", () => {
		const probe = new DiskProbe(fakeSource(new Map()), { batchSize: 0 });

		expect(probe.select(["a", "b"])).toEqual(["a"]);
	});
});

describe("audit-trail-box probe readings", () => {
	it("reports content and a hash for a readable path", async () => {
		const probe = new DiskProbe(fakeSource(new Map([["src/a.ts", "alpha\n"]])));

		const readings = await probe.tick(["src/a.ts"]);

		expect(readings).toEqual([
			{ path: "src/a.ts", hash: hashContent("alpha\n"), content: "alpha\n", reachable: true },
		]);
	});

	it("reports an unreadable path as unreachable with no hash", async () => {
		const probe = new DiskProbe(fakeSource(new Map()));

		const readings = await probe.tick(["src/gone.ts"]);

		expect(readings).toEqual([{ path: "src/gone.ts", hash: undefined, reachable: false }]);
	});

	it("inspects only the paths in this tick's slice", async () => {
		const source = fakeSource(new Map([["a", "1"]]));
		const probe = new DiskProbe(source, { batchSize: 1 });

		await probe.tick(["a", "b", "c"]);

		expect(source.inspected).toEqual(["a"]);
	});

	it("feeds the ledger straight through to POISONED", async () => {
		const files = new Map([["src/a.ts", "before\n"]]);
		const source = fakeSource(files);
		const probe = new DiskProbe(source);
		const state = new AuditLedgerState();
		state.noteRead("src/a.ts", { hash: hashContent("before\n"), content: "before\n" });

		files.set("src/a.ts", "after\n");
		for (let tick = 0; tick < POISON_STREAK_TICKS; tick++) {
			state.noteProbe(await probe.tick(["src/a.ts"]), 10_000 + tick * 1000);
		}

		const record = state.record("src/a.ts");
		expect(record?.status).toBe("poisoned");
		expect(record?.contextContent).toBe("before\n");
		expect(record?.contentNow).toBe("after\n");
	});
});

describe("audit-trail-box filesystem probe source", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "audit-trail-box-"));
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads an existing file's content and hash", async () => {
		const path = join(dir, "present.txt");
		await writeFile(path, "alpha\n");

		const observed = await createFileProbeSource().inspect(path);

		expect(observed).toEqual({ hash: hashContent("alpha\n"), content: "alpha\n" });
	});

	it("returns a different hash once the file changes on disk", async () => {
		const path = join(dir, "changing.txt");
		const source = createFileProbeSource();
		await writeFile(path, "before\n");
		const first = await source.inspect(path);

		await writeFile(path, "after\n");
		const second = await source.inspect(path);

		expect(second?.hash).not.toBe(first?.hash);
	});

	it("handles an empty file without reporting it unreachable", async () => {
		const path = join(dir, "empty.txt");
		await writeFile(path, "");

		const observed = await createFileProbeSource().inspect(path);

		expect(observed).toEqual({ hash: hashContent(""), content: "" });
	});

	it("reports a missing file as unreachable", async () => {
		const observed = await createFileProbeSource().inspect(join(dir, "never-existed.txt"));

		expect(observed).toBeUndefined();
	});

	it("reports a directory as unreachable rather than throwing", async () => {
		const observed = await createFileProbeSource().inspect(dir);

		expect(observed).toBeUndefined();
	});

	it("identifies an oversized file by stat signature instead of pulling in its bytes", async () => {
		const path = join(dir, "large.txt");
		await writeFile(path, "x".repeat(64));

		const observed = await createFileProbeSource(16).inspect(path);

		expect(observed?.content).toBeUndefined();
		expect(observed?.hash).toStartWith("stat:64:");
	});
});
