import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
import type { MacCapabilityKey, MacCapabilityRegistry } from "./capabilities.js";
import type { WorkspaceFactory, ApprovalLinkBuilder } from "./di.js";
import type { MacRouteContribution, MacClassifierIntent } from "./routing-config.js";

/**
 * Authoring helpers for built-in AND custom agents/workflows (MAC refactor
 * Phase 2). There is one constructor for both — a custom definition is a
 * first-class peer of the built-ins.
 *
 * These are *defined* in `/core` (pure constructors, no preset dependency) and
 * re-exported from the `@nearform/mac` root. App code may import them from the
 * root; subpackages MUST import them from `@nearform/mac/core` to keep the
 * dependency direction one-way (see the refactor doc's cycle guard).
 */

export interface AgentCreateContext {
  /** The host model id (or a per-agent override resolved by the host). */
  model: string;
  capabilities: MacCapabilityRegistry;
  workspaceFactory?: WorkspaceFactory;
  /** Optional; undefined if the app did not configure one (symmetry with workflows). */
  approvalLinks?: ApprovalLinkBuilder;
}

export interface WorkflowCreateContext {
  model: string;
  capabilities: MacCapabilityRegistry;
  /** Optional; undefined if the app did not configure one. */
  workspaceFactory?: WorkspaceFactory;
  /** Optional; undefined if the app did not configure one. */
  approvalLinks?: ApprovalLinkBuilder;
}

export interface MacAgentDefinition {
  id: string;
  description: string;
  /** Set to a built-in id to deliberately replace it. */
  overrides?: string;
  requires?: MacCapabilityKey<unknown>[];
  optional?: MacCapabilityKey<unknown>[];
  /** Deterministic route contributions this agent owns (Phase 11). */
  routes?: MacRouteContribution[];
  /** Classifier intents this agent owns (Phase 11). */
  classifierIntents?: MacClassifierIntent[];
  create(context: AgentCreateContext): Agent;
}

export interface MacWorkflowDefinition {
  id: string;
  description: string;
  /** Set to a built-in id to deliberately replace it. */
  overrides?: string;
  requires?: MacCapabilityKey<unknown>[];
  optional?: MacCapabilityKey<unknown>[];
  /** Agent ids this workflow needs from the agent registry (for transitive enabling). */
  requiredAgents?: string[];
  /**
   * Deterministic route contributions this workflow owns (Phase 11) — e.g.
   * pr-review's GitHub PR-attention route. The host collects these alongside
   * the workflow and preflights their targets against the final registry.
   */
  routes?: MacRouteContribution[];
  /** Classifier intents this workflow owns (Phase 11) — e.g. the BUILD / REVIEW intents. */
  classifierIntents?: MacClassifierIntent[];
  create(context: WorkflowCreateContext): Workflow;
}

/** Identity constructor — gives custom + built-in definitions a typed surface. */
export function defineAgent(def: MacAgentDefinition): MacAgentDefinition {
  return def;
}

/** Identity constructor — gives custom + built-in definitions a typed surface. */
export function defineWorkflow(def: MacWorkflowDefinition): MacWorkflowDefinition {
  return def;
}
