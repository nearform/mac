/**
 * `@nearform/mac/core` — the dependency-light contracts and authoring helpers.
 *
 * This is the sink of the MAC dependency graph: it imports only `@mastra/core`
 * types, never a platform SDK, the preset root, or any agent/workflow package.
 * Subpackages (`-github`, `-slack`, `-agent-workflows`) import their shared
 * types and the `define*` helpers from here.
 */

// Event contract
export type { EventEnvelope, EventType, DispatchFn } from "./events.js";

// Classifier contract (types only — the default impl lives in the preset layer)
export type {
  ClassifierContext,
  MacClassification,
  MacClassifier,
} from "./classification.js";

// Contribution-based routing config (host-assembled)
export type {
  RouteContext,
  MacRouteTarget,
  MacRouteContribution,
  MacClassifierIntent,
  MacRoutingConfig,
  MacGuardConfig,
  ReplyGateLookup,
} from "./routing-config.js";

// Shared route-target input shaping helpers
export {
  splitRepo,
  slackOriginFromEnvelope,
  flagPrefix,
  applyInjectionFlag,
} from "./route-helpers.js";

// Capabilities
export type { MacCapabilityKey, MacCapabilityRegistry, PlatformCapabilities } from "./capabilities.js";
export { capabilityKey, createCapabilityRegistry } from "./capabilities.js";

// Extension model
export type { MacExtension, MacExtensionContext, MacExtensionResult } from "./extension.js";

// Authoring helpers + definitions
export type {
  MacAgentDefinition,
  MacWorkflowDefinition,
  AgentCreateContext,
  WorkflowCreateContext,
} from "./definitions.js";
export { defineAgent, defineWorkflow } from "./definitions.js";

// Agent registry capability
export type { MacAgentRegistry } from "./agent-registry.js";
export { agentRegistryCapability, createAgentRegistry } from "./agent-registry.js";

// Dependency-injection contracts
export type {
  WorkspaceFactory,
  ApprovalLinkBuilder,
  InteractiveDispatch,
  InteractiveTurn,
} from "./di.js";
