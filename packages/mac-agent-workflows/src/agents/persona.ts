import { loadAgentContext } from "../loaders/agent-context.js";

/**
 * The shared persona preamble: the concatenated `agent-context/*.md` (persona +
 * rules + security), followed by a separator — or empty when no context dir is
 * present. Prepended to each agent's prompt body.
 */
export function persona(): string {
  const p = loadAgentContext();
  return p ? `${p}\n\n---\n\n` : "";
}
