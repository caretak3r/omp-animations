import * as path from "node:path";

const INTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATCH_HEADER = /^\[([^#\]\r\n]+)#[0-9A-F]{4}\]$/i;
const PATCH_OPERATION = /^(?:PUT|CUT)\s+[<>]?(\d+)/;

export interface MutationTarget {
	readonly path: string;
	readonly line?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function recordFromText(raw: string): Record<string, unknown> | undefined {
	try {
		return asRecord(Bun.JSON5.parse(raw));
	} catch {
		const pathMatch = /["']?path["']?\s*[:=]\s*["']([^"'\r\n]+)["']/.exec(raw);
		return pathMatch?.[1] ? { path: pathMatch[1] } : undefined;
	}
}

function patchTargets(patch: string): readonly MutationTarget[] {
	const targets: MutationTarget[] = [];
	let current: MutationTarget | undefined;
	for (const line of patch.split(/\r?\n/)) {
		const header = PATCH_HEADER.exec(line);
		if (header?.[1]) {
			if (current !== undefined) targets.push(current);
			current = { path: header[1] };
			continue;
		}
		if (current === undefined || current.line !== undefined) continue;
		const operation = PATCH_OPERATION.exec(line);
		if (operation?.[1]) current = { ...current, line: Number(operation[1]) };
	}
	if (current !== undefined) targets.push(current);
	return targets;
}

function stringArray(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function lspTargets(value: unknown): readonly MutationTarget[] {
	const input = typeof value === "string" ? recordFromText(value) : asRecord(value);
	if (input === undefined || typeof input.action !== "string") return [];
	const applies = input.action === "code_actions" ? input.apply === true : input.apply !== false;
	if (!applies || (input.action !== "rename" && input.action !== "rename_file" && input.action !== "code_actions")) {
		return [];
	}
	if (typeof input.file !== "string" || input.file.length === 0) return [];
	return [{ path: input.file, line: typeof input.line === "number" ? input.line : undefined }];
}

function writeTargets(input: Record<string, unknown>): readonly MutationTarget[] {
	if (typeof input.path !== "string" || input.path.length === 0) return [];
	if (input.path === "xd://ast_edit") {
		const payload = typeof input.content === "string" ? recordFromText(input.content) : asRecord(input.content);
		return stringArray(payload?.paths).map(target => ({ path: target }));
	}
	if (input.path === "xd://lsp") return lspTargets(input.content);
	if (INTERNAL_SCHEME.test(input.path)) return [];
	return [{ path: input.path }];
}

function rawTargets(toolName: string, args: unknown): readonly MutationTarget[] {
	if (toolName === "edit" && typeof args === "string") {
		const fromPatch = patchTargets(args);
		if (fromPatch.length > 0) return fromPatch;
	}
	const input = typeof args === "string" ? recordFromText(args) : asRecord(args);
	if (input === undefined) return [];

	if (toolName === "edit") {
		if (typeof input.patch === "string") {
			const fromPatch = patchTargets(input.patch);
			if (fromPatch.length > 0) return fromPatch;
		}
		return typeof input.path === "string" && input.path.length > 0 ? [{ path: input.path }] : [];
	}
	if (toolName === "write") return writeTargets(input);
	if (toolName === "ast_edit") return stringArray(input.paths).map(target => ({ path: target }));
	if (toolName === "lsp") return lspTargets(input);
	return [];
}

function displayPath(target: string, cwd: string): string {
	if (INTERNAL_SCHEME.test(target)) return target;
	const absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
	const relative = path.relative(cwd, absolute);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." ? relative : target;
}

export function normalizeMutationTargets(toolName: string, args: unknown, cwd: string): readonly MutationTarget[] {
	const targets = rawTargets(toolName, args);
	const unique = new Map<string, MutationTarget>();
	for (const target of targets) {
		const normalized = { ...target, path: displayPath(target.path, cwd) };
		const key = `${normalized.path}:${normalized.line ?? ""}`;
		if (!unique.has(key)) unique.set(key, normalized);
	}
	return [...unique.values()];
}
