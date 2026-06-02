import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
import type { ApiRoute } from "@mastra/core/server";
import type { MCPServerBase } from "@mastra/core/mcp";
import type { DispatchFn } from "./events.js";
import type { MacCapabilityKey, MacCapabilityRegistry } from "./capabilities.js";
import type { MacRouteContribution, MacClassifierIntent } from "./routing-config.js";
import type { WorkspaceFactory } from "./di.js";

/**
 * The uniform plug-in model for `createMacApp`. GitHub, Slack, agents, and
 * workflows are all installed as extensions, so the host stays open to future
 * platforms (Discord, Linear, email, cron, CLI). The host config groups them by
 * role (`platforms` / `agents` / `workflows`) but normalizes everything into one
 * init/merge path.
 *
 * Added in MAC refactor Phase 2; the host that consumes these arrives in Phase 6.
 */
export interface MacExtension {
  name: string;
  /** Capabilities this extension publishes (e.g. githubCapabilities). */
  provides?: MacCapabilityKey<unknown>[];
  /** Capabilities this extension consumes. The host uses these to order init. */
  requires?: MacCapabilityKey<unknown>[];
  /**
   * Capabilities this extension *prefers* but can run without. The host orders
   * init after any provider (so `capabilities.optional(key)` sees the configured
   * value when present) but does NOT fail preflight when no provider exists.
   * Use this for graceful degradation — e.g. `agents()` works without GitHub.
   */
  optional?: MacCapabilityKey<unknown>[];
  init(context: MacExtensionContext): MacExtensionResult | Promise<MacExtensionResult>;
}

export interface MacExtensionContext {
  model: string;
  workspaceFactory?: WorkspaceFactory;
  dispatch: DispatchFn;
  capabilities: MacCapabilityRegistry;
}

export interface MacExtensionResult {
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow>;
  apiRoutes?: ApiRoute[];
  mcpServers?: Record<string, MCPServerBase>;
  routes?: MacRouteContribution[];
  classifierIntents?: MacClassifierIntent[];
  runtime?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}
