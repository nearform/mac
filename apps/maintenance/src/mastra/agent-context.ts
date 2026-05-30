import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Concatenate the agent-context/*.md files (persona + rules + security) into a
 * single instructions preamble, ported in spirit from lastlight's
 * `loadAgentContext`. Files are joined alphabetically (rules, security, soul)
 * with separators. Resolved relative to the repo root so it works under both
 * `mastra dev` and the built output.
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

/** Find the agent-context dir, honoring LASTLIGHT_AGENT_CONTEXT_DIR. */
function resolveAgentContextDir(): string | null {
  const fromEnv = process.env.LASTLIGHT_AGENT_CONTEXT_DIR;
  if (fromEnv) return resolve(fromEnv);
  // From src/mastra/ -> repo root is ../../../.. ; from .mastra/output it differs,
  // so try a few candidates relative to this module and cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../../agent-context"),
    join(here, "../../../agent-context"),
    join(process.cwd(), "agent-context"),
    join(process.cwd(), "../../agent-context"),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}
