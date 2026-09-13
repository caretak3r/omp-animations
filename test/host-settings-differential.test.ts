import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigDirName } from "@oh-my-pi/pi-utils";
import { readPluginSettingsSync } from "../src/registrar";
import { runHostResolver, writeGlobalLockfile, writeProjectOverride } from "./installed-host-harness";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function setupFixture() {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-diff-"));
	const home = path.join(tempDir, "home");
	const cwd = path.join(tempDir, "project");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	return { home, cwd };
}

describe("host settings differential", () => {
	test("global only", async () => {
		const { home, cwd } = setupFixture();
		const settings = { foo: "bar", num: 42 };

		writeGlobalLockfile(home, settings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(settings);
	});

	test("project only (.omp)", async () => {
		const { home, cwd } = setupFixture();
		const settings = { project: "value" };

		writeProjectOverride(cwd, ".omp", settings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(settings);
	});

	test("project only (.claude)", async () => {
		const { home, cwd } = setupFixture();
		const settings = { claude: true };

		writeProjectOverride(cwd, ".claude", settings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(settings);
	});

	test("project only (.codex)", async () => {
		const { home, cwd } = setupFixture();
		const settings = { codex: 1 };

		writeProjectOverride(cwd, ".codex", settings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(settings);
	});

	test("project only (.gemini)", async () => {
		const { home, cwd } = setupFixture();
		const settings = { gemini: "rocks" };

		writeProjectOverride(cwd, ".gemini", settings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(settings);
	});

	test("global + project merge (project wins)", async () => {
		const { home, cwd } = setupFixture();
		const globalSettings = { a: 1, b: 2, shared: "global" };
		const projectSettings = { c: 3, shared: "project" };

		writeGlobalLockfile(home, globalSettings);
		writeProjectOverride(cwd, ".omp", projectSettings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual({ a: 1, b: 2, c: 3, shared: "project" });
	});

	test("multiple override dirs present → first in priority wins", async () => {
		const { home, cwd } = setupFixture();
		const ompSettings = { source: "omp", value: 1 };
		const claudeSettings = { source: "claude", value: 2 };

		writeProjectOverride(cwd, ".omp", ompSettings);
		writeProjectOverride(cwd, ".claude", claudeSettings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(ompSettings);
	});

	test("unparseable project override → fallthrough to next dir", async () => {
		const { home, cwd } = setupFixture();
		const validSettings = { fallback: true };

		// Write unparseable JSON to .omp
		const badOverrideDir = path.join(cwd, ".omp");
		fs.mkdirSync(badOverrideDir, { recursive: true });
		fs.writeFileSync(path.join(badOverrideDir, "plugin-overrides.json"), "{invalid json");

		// Write valid JSON to .claude
		writeProjectOverride(cwd, ".claude", validSettings);

		const mirror = readPluginSettingsSync(cwd, home);
		const { exitCode, stdout } = await runHostResolver({ home, cwd });
		expect(exitCode).toBe(0);
		const host = JSON.parse(stdout);

		expect(host).toEqual(mirror);
		expect(mirror).toEqual(validSettings);
	});

	test("documented divergence: corrupt global lockfile", async () => {
		const { home, cwd } = setupFixture();
		const projectSettings = { safe: "project" };

		// Write corrupt global lockfile
		const pluginsDir = path.join(home, getConfigDirName(), "plugins");
		fs.mkdirSync(pluginsDir, { recursive: true });
		fs.writeFileSync(path.join(pluginsDir, "omp-plugins.lock.json"), "{corrupt");

		// Write valid project override
		writeProjectOverride(cwd, ".omp", projectSettings);

		// Mirror degrades to project-only result (registrar.ts:166-168)
		const mirror = readPluginSettingsSync(cwd, home);
		expect(mirror).toEqual(projectSettings);

		// Host child exits non-zero (rethrows, loader.ts:53)
		const { exitCode } = await runHostResolver({ home, cwd });
		expect(exitCode).not.toBe(0);
	});
});
