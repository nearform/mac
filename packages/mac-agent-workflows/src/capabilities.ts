import type { Agent } from "@mastra/core/agent";
import {
  agentRegistryCapability,
  type MacAgentRegistry,
  type MacCapabilityKey,
} from "@nearform/mac/core";

/**
 * `@nearform/mac-agent-workflows/capabilities` — the typed convenience bundle
 * for the built-in agents, layered on top of the core agent registry.
 *
 * `MacAgents` extends the core `MacAgentRegistry` (the `byId`/`find`/`ids`
 * lookup over EVERY registered agent) with compile-time named fields for the
 * built-ins, so built-in workflows can do `agents.reviewer` without a string
 * lookup. `agentCapabilities` is the same `"agents"` key as the core
 * `agentRegistryCapability`, narrowed to the built-in bundle — same id, same
 * registry value, just a typed view (see the refactor doc, "Agent Bundle").
 */
export interface MacAgents extends MacAgentRegistry {
  chat: Agent;
  reviewer: Agent;
  buildReviewer: Agent;
  guardrails: Agent;
  architect: Agent;
  executor: Agent;
  fix: Agent;
}

/** The built-in-typed view of the core `agentRegistryCapability` (id "agents"). */
export const agentCapabilities = agentRegistryCapability as MacCapabilityKey<MacAgents>;
