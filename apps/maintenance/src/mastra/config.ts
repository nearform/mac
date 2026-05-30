/**
 * Minimal runtime config for the spike. Replaces lastlight's layered YAML
 * overlay (config/default.yaml + instance overlay + env) with plain env reads.
 * See ../../../MIGRATION.md — config overlay layering is intentionally dropped.
 */

/** Absolute SQLite URL, cwd-independent (see index.ts note on libsql error 14). */
export function dbUrl(): string {
  return (
    process.env.LASTLIGHT_DB_URL ??
    `file:${process.env.LASTLIGHT_STATE_DIR ?? process.cwd()}/lastlight.db`
  );
}

/**
 * Default model router string. Spike uses OpenAI (the key present in the copied
 * .env); override with LASTLIGHT_MODEL. lastlight's configured
 * anthropic/claude-sonnet-4-6 needs ANTHROPIC_API_KEY to be added first.
 */
export function defaultModel(): string {
  return process.env.LASTLIGHT_MODEL ?? "openai/gpt-4o";
}
