import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Layered prompt loader (MAC package refactor, Phase 5b).
 *
 * Resolves a prompt `key` to its markdown text. Lookup order:
 *   1. `<overrideDir>/<key>.md` — if an override dir is configured via
 *      `MAC_PROMPTS_DIR`. Lets an operator swap instructions without a rebuild.
 *      The override dir is the only cwd-relative lookup.
 *   2. The package default `../../prompts/<key>.md`, resolved relative to THIS
 *      module via `import.meta.url` (never `process.cwd()`, never `../..`
 *      walking) so it works identically under `mastra dev`, the built output,
 *      and when the package is resolved from `node_modules`. This file lives at
 *      `src/loaders/prompts.ts`, so `../../prompts/` reaches the package's own
 *      `prompts/` directory.
 *
 * The contents are `.trimEnd()`'d so a conventional trailing newline in the
 * `.md` file does not leak into the composed instruction. Leading content is
 * preserved.
 *
 * IMPORTANT: this loader never references the repo-root `/prompts` or `/skills`
 * directories (those are dormant). Defaults live only in this package.
 */
export interface PromptResolver {
  resolve(key: string): string;
}

/** Find the configured override dir, if any, via `MAC_PROMPTS_DIR`. */
function overrideDir(): string | null {
  const fromEnv = process.env.MAC_PROMPTS_DIR;
  return fromEnv ? resolve(fromEnv) : null;
}

/** Resolve a prompt key to its trimmed markdown text. */
export function resolvePrompt(key: string): string {
  const dir = overrideDir();
  if (dir) {
    try {
      return readFileSync(resolve(dir, `${key}.md`), "utf-8").trimEnd();
    } catch {
      /* fall through to the package default */
    }
  }
  const defaultPath = fileURLToPath(
    new URL(`../../prompts/${key}.md`, import.meta.url),
  );
  return readFileSync(defaultPath, "utf-8").trimEnd();
}

/** The default resolver instance. */
export const defaultPromptResolver: PromptResolver = {
  resolve: resolvePrompt,
};
