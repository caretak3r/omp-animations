/**
 * Resolve a skill name to its `SKILL.md` on disk.
 *
 * The host resolves `skill://<name>` through its active-skill registry, which is
 * module state a plugin cannot reach (see `progress.ts`). Skills always live at
 * `<root>/<name>/SKILL.md`, optionally one group deep (`<root>/<group>/<name>`),
 * so the Bonsai finds the file itself and caches every lookup — including
 * misses — to keep rendering allocation- and syscall-free after first sight.
 */
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Skill roots in precedence order: project scopes first, then user scopes. */
export function skillRoots(cwd: string, home: string = os.homedir()): readonly string[] {
	return [
		path.join(cwd, ".omp", "skills"),
		path.join(cwd, ".agents", "skills"),
		path.join(cwd, ".claude", "skills"),
		path.join(home, ".omp", "agent", "skills"),
		path.join(home, ".omp", "agent", "managed-skills"),
		path.join(home, ".agents", "skills"),
		path.join(home, ".claude", "skills"),
	];
}

export type SkillPathResolver = (name: string) => string | undefined;

function findSkillFile(name: string, roots: readonly string[]): string | undefined {
	for (const root of roots) {
		const direct = path.join(root, name, "SKILL.md");
		if (existsSync(direct)) return direct;
	}
	for (const root of roots) {
		let groups: readonly string[];
		try {
			groups = readdirSync(root, { withFileTypes: true })
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name);
		} catch {
			continue;
		}
		for (const group of groups) {
			const nested = path.join(root, group, name, "SKILL.md");
			if (existsSync(nested)) return nested;
		}
	}
	return undefined;
}

/**
 * Build a memoized resolver. Unresolvable names are cached as misses so a
 * subagent reading a skill from a root this process cannot see costs one scan,
 * not one per render.
 */
export function createSkillPathResolver(cwd: string, home?: string): SkillPathResolver {
	const roots = skillRoots(cwd, home);
	const cache = new Map<string, string | undefined>();
	return name => {
		const cached = cache.get(name);
		if (cached !== undefined || cache.has(name)) return cached;
		const resolved = findSkillFile(name, roots);
		cache.set(name, resolved);
		return resolved;
	};
}
