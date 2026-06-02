import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Skills location resolver (Mastra Skills adoption).
 *
 * Mastra discovers skills from a base path plus a list of paths, where each
 * path may be a CONTAINER of skill folders OR a direct skill folder (each with a
 * `SKILL.md`); see https://mastra.ai/docs/workspace/skills. We keep all skills
 * in this package's flat `skills/` container and select a SUBSET per agent by
 * passing the skill folder names directly as `skills:` paths.
 *
 * This module is MECHANISM ONLY: it resolves the skills base path and builds a
 * `{ basePath, paths }` location from a caller-supplied list of skill names. It
 * deliberately does NOT decide which step gets which skills — that policy lives
 * in the workflow definitions (see `workflows/build.ts`, `workflows/pr-review.ts`),
 * which own step orchestration. The Workspace is wired with
 * `LocalSkillSource({ basePath })` so skills load from THIS package regardless
 * of the per-run checkout filesystem (whose basePath is a task-specific clone
 * dir — the wrong place to look for skills).
 *
 * Base-path lookup mirrors the prompt + agent-context loaders:
 *   1. `MAC_SKILLS_DIR` — app override container dir (cwd-relative).
 *   2. The package default `../../skills`, resolved relative to THIS module via
 *      `import.meta.url` (never `process.cwd()`), so it works identically under
 *      `mastra dev`, the built output, and from `node_modules`.
 */
export interface SkillsLocation {
  /** Base path passed to `new LocalSkillSource({ basePath })`. */
  basePath: string;
  /** Skill folder names (relative to basePath) passed to `Workspace.skills`. */
  paths: string[];
}

/** Absolute path to the active skills container directory (the base path). */
export function skillsContainerDir(): string {
  const fromEnv = process.env.MAC_SKILLS_DIR;
  if (fromEnv) return resolve(fromEnv);
  return fileURLToPath(new URL("../../skills", import.meta.url));
}

/**
 * Build the `{ basePath, paths }` location for a scoped set of skill names.
 * Callers (workflow steps) decide the names; this just resolves the base path.
 */
export function skillsLocation(names: readonly string[]): SkillsLocation {
  return { basePath: skillsContainerDir(), paths: [...names] };
}
