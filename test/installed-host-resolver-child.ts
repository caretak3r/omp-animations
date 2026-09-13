import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

const projectDir = process.argv[2];
if (!projectDir) {
	console.error("Usage: bun run installed-host-resolver-child.ts <project-dir>");
	process.exit(1);
}

const result = await getPluginSettings("@oh-my-pi/animations", projectDir);
console.log(JSON.stringify(result));
