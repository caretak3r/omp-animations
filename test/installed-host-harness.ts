import fs from "node:fs";
import path from "node:path";
import { getConfigDirName } from "@oh-my-pi/pi-utils";

const HOST_PKG_JSON = path.join(path.dirname(import.meta.dir), "node_modules/@oh-my-pi/pi-coding-agent/package.json");

export function installedHostVersion(): string {
	const pkg = JSON.parse(fs.readFileSync(HOST_PKG_JSON, "utf-8"));
	return pkg.version;
}

export function writeGlobalLockfile(home: string, settings: Record<string, unknown>): void {
	const pluginsDir = path.join(home, getConfigDirName(), "plugins");
	fs.mkdirSync(pluginsDir, { recursive: true });

	const lockfile = path.join(pluginsDir, "omp-plugins.lock.json");
	const data = {
		settings: {
			"@oh-my-pi/animations": settings,
		},
	};
	fs.writeFileSync(lockfile, JSON.stringify(data, null, 2));
}

export function writeProjectOverride(cwd: string, dir: string, settings: Record<string, unknown>): void {
	const overrideDir = path.join(cwd, dir);
	fs.mkdirSync(overrideDir, { recursive: true });

	const overrideFile = path.join(overrideDir, "plugin-overrides.json");
	const data = {
		settings: {
			"@oh-my-pi/animations": settings,
		},
	};
	fs.writeFileSync(overrideFile, JSON.stringify(data, null, 2));
}

export async function runHostResolver(opts: {
	home: string;
	cwd: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const childScript = path.join(import.meta.dir, "installed-host-resolver-child.ts");
	const worktreeRoot = path.dirname(import.meta.dir);

	const env = { ...process.env };
	env.HOME = opts.home;
	delete env.XDG_DATA_HOME;
	delete env.XDG_CONFIG_HOME;
	delete env.XDG_STATE_HOME;

	const proc = Bun.spawn([process.execPath, "run", childScript, opts.cwd], {
		cwd: worktreeRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);

	const exitCode = await proc.exited;

	return { exitCode, stdout, stderr };
}
