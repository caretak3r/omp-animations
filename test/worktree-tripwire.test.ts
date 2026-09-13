import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function setupGitRepo() {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-"));
	const repoDir = path.join(tempDir, "repo");
	fs.mkdirSync(repoDir, { recursive: true });

	const git = (args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: repoDir,
			encoding: "utf-8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		});
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result;
	};

	git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "init", "-q"]);
	fs.writeFileSync(path.join(repoDir, "tracked1.txt"), "initial content\n");
	fs.writeFileSync(path.join(repoDir, "tracked2.txt"), "more content\n");
	git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "add", "tracked1.txt", "tracked2.txt"]);
	git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);

	fs.writeFileSync(path.join(repoDir, "untracked.txt"), "untracked content\n");
	fs.symlinkSync("tracked1.txt", path.join(repoDir, "link.txt"));

	fs.mkdirSync(path.join(repoDir, ".beads"), { recursive: true });
	fs.writeFileSync(path.join(repoDir, ".beads", "ignored.txt"), "ignored\n");
	fs.mkdirSync(path.join(repoDir, ".frames"), { recursive: true });
	fs.writeFileSync(path.join(repoDir, ".frames", "ignored.txt"), "ignored\n");

	return repoDir;
}

function runTripwire(subcommand: string, root: string, manifestPath: string) {
	const scriptPath = path.join(import.meta.dir, "..", "scripts", "worktree-tripwire.sh");
	const result = spawnSync("bash", [scriptPath, subcommand, root, manifestPath], {
		encoding: "utf-8",
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

describe("worktree tripwire", () => {
	test("snapshot then verify on untouched tree", () => {
		const repoDir = setupGitRepo();
		const manifestPath = path.join(tempDir!, "manifest.txt");

		const snapshotResult = runTripwire("snapshot", repoDir, manifestPath);
		expect(snapshotResult.exitCode).toBe(0);
		expect(fs.existsSync(manifestPath)).toBe(true);

		const verifyResult = runTripwire("verify", repoDir, manifestPath);
		expect(verifyResult.exitCode).toBe(0);
		expect(verifyResult.stdout).toContain("tripwire: clean");
	});

	test("modify, delete, add, retarget paths", () => {
		const repoDir = setupGitRepo();
		const manifestPath = path.join(tempDir!, "manifest.txt");

		runTripwire("snapshot", repoDir, manifestPath);

		fs.writeFileSync(path.join(repoDir, "tracked1.txt"), "modified content\n");
		fs.unlinkSync(path.join(repoDir, "tracked2.txt"));
		fs.writeFileSync(path.join(repoDir, "new-untracked.txt"), "new content\n");
		fs.unlinkSync(path.join(repoDir, "link.txt"));
		fs.symlinkSync("tracked2.txt", path.join(repoDir, "link.txt"));

		const verifyResult = runTripwire("verify", repoDir, manifestPath);
		expect(verifyResult.exitCode).toBe(1);

		const lines = verifyResult.stdout.split("\n").filter(l => l.trim());
		const driftLines = lines.filter(l => !l.startsWith("tripwire:"));
		const summaryLine = lines.find(l => l.startsWith("tripwire:"));

		expect(driftLines).toContain("changed tracked1.txt");
		expect(driftLines).toContain("removed tracked2.txt");
		expect(driftLines).toContain("added new-untracked.txt");
		expect(driftLines).toContain("changed link.txt");
		expect(driftLines.length).toBe(4);
		expect(summaryLine).toBe("tripwire: 4 drifted path(s)");
	});

	test("writes into .beads/ and .frames/ ignored", () => {
		const repoDir = setupGitRepo();
		const manifestPath = path.join(tempDir!, "manifest.txt");

		runTripwire("snapshot", repoDir, manifestPath);

		fs.writeFileSync(path.join(repoDir, ".beads", "new-file.txt"), "new beads content\n");
		fs.writeFileSync(path.join(repoDir, ".frames", "new-file.txt"), "new frames content\n");

		const verifyResult = runTripwire("verify", repoDir, manifestPath);
		expect(verifyResult.exitCode).toBe(0);
		expect(verifyResult.stdout).toContain("tripwire: clean");
	});

	test("path with space tracked correctly", () => {
		const repoDir = setupGitRepo();
		const manifestPath = path.join(tempDir!, "manifest.txt");

		const spacePath = path.join(repoDir, "file with space.txt");
		fs.writeFileSync(spacePath, "space content\n");

		runTripwire("snapshot", repoDir, manifestPath);

		fs.writeFileSync(spacePath, "modified space content\n");

		const verifyResult = runTripwire("verify", repoDir, manifestPath);
		expect(verifyResult.exitCode).toBe(1);
		expect(verifyResult.stdout).toContain("changed file with space.txt");
	});

	test("verify with missing manifest", () => {
		const repoDir = setupGitRepo();
		const manifestPath = path.join(tempDir!, "nonexistent-manifest.txt");

		const verifyResult = runTripwire("verify", repoDir, manifestPath);
		expect(verifyResult.exitCode).toBe(2);
	});
});
