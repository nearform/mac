import type { Agent } from "@mastra/core/agent";
import { capabilityKey, type MacCapabilityKey } from "./capabilities.js";

/**
 * The core-owned agent registry capability.
 *
 * Its value exposes every registered agent by id — built-in *and* custom
 * `defineAgent` agents — so a pure bring-your-own app can resolve agents from a
 * custom workflow without depending on `@nearform/mac-agent-workflows`. The
 * built-in agent package layers a typed `MacAgents` convenience bundle on top
 * of this same key/value (same id "agents").
 *
 * Whichever view a workflow consumes, the value is always constructed,
 * registered `Agent` instances — never `create*` factories — so the
 * observability exporter stays wired (see the refactor doc, "Agent Bundle").
 *
 * Added in MAC refactor Phase 2.
 */
export interface MacAgentRegistry {
  /** Any registered agent (built-in or custom) by id; throws if absent. */
  byId(id: string): Agent;
  /** Non-throwing lookup. */
  find(id: string): Agent | undefined;
  ids(): string[];
}

export const agentRegistryCapability =
  capabilityKey<MacAgentRegistry>("agents", "registered agents");

/** Build a `MacAgentRegistry` view over a plain id → Agent record. */
export function createAgentRegistry(agents: Record<string, Agent>): MacAgentRegistry {
  return {
    byId(id) {
      const agent = agents[id];
      if (!agent) {
        throw new Error(
          `agent "${id}" is not registered (available: ${Object.keys(agents).join(", ") || "none"})`,
        );
      }
      return agent;
    },
    find(id) {
      return agents[id];
    },
    ids() {
      return Object.keys(agents);
    },
  };
}

/** Re-export for the key type narrowing the built-in package performs. */
export type { MacCapabilityKey };
