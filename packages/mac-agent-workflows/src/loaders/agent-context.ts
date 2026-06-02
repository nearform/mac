import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Concatenate the agent-context/*.md files (persona + rules + security) into a
 * single instructions preamble. Files are joined alphabetically (rules,
 * security, soul) with separators.
 *
 * Lookup order:
 *   1. `MAC_AGENT_CONTEXT_DIR` — the documented app override dir, resolved
 *      relative to cwd.
 *   2. The package default `../../agent-context`, resolved relative to THIS
 *      module via `import.meta.url` (never `process.cwd()` candidate walking)
 *      so it works identically under `mastra dev`, the built output, and when
 *      the package is resolved from `node_modules`. This file lives at
 *      `src/loaders/agent-context.ts`, so `../../agent-context` reaches the
 *      package's own `agent-context/` directory.
 */
export function loadAgentContext(): string {
  const dir = resolveAgentContextDir();
  if (!dir) return "";
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return files
    .map((f) => readFileSync(join(dir, f), "utf-8").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/** Find the agent-context dir via `MAC_AGENT_CONTEXT_DIR`, else the package default. */
function resolveAgentContextDir(): string | null {
  const fromEnv = process.env.MAC_AGENT_CONTEXT_DIR;
  if (fromEnv) return resolve(fromEnv);
  return fileURLToPath(new URL("../../agent-context", import.meta.url));
}
