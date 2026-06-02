/**
 * MAC MCP surface — the typed selection/gating layer for an MCP export.
 *
 * This computes a *manifest* (`MacMcpSurface`) describing the intended MCP
 * surface: which tool groups, workflows, and agents would be exposed once a
 * concrete server is constructed. It deliberately does NOT construct a live
 * `@mastra/mcp` `MCPServer` — that dependency is not installed. See the
 * `// TODO(MCP)` note in `create-mac-app.ts`.
 *
 * MCP is opt-in: with no `mcp` config (or `enabled: false`) the surface is
 * empty and the embedded app path is unaffected.
 */

export interface MacMcpConfig {
  /** Enable the MCP surface. Default false — MCP is opt-in. */
  enabled?: boolean;
  /** Expose safe GitHub read tools. Default true (when enabled). */
  exposeReadTools?: boolean;
  /** Workflow ids to expose. Default: ["pr-review"] when registered. */
  exposeWorkflows?: string[];
  /** Agent ids to expose. Default: ["chat"] when registered. */
  exposeAgents?: string[];
  /** Allow write tools (e.g. github review). Default false. */
  allowWrite?: boolean;
  /** Allow the build workflow. Requires allowWrite AND approvalLinks configured. Default false. */
  allowBuild?: boolean;
}

/** The resolved, gated MCP surface (a manifest — not a live server yet). */
export interface MacMcpSurface {
  enabled: boolean;
  toolGroups: string[]; // e.g. ["github:read"], plus "github:review" only when allowWrite
  workflows: string[]; // resolved + gated + description-validated ids
  agents: string[]; // resolved + description-validated ids
}

/**
 * Compute the gated MCP surface from the host config and the final registries.
 *
 * Gating rules:
 * - Disabled config → empty surface.
 * - `toolGroups`: "github:read" when read tools enabled (default on);
 *   "github:review" only when `allowWrite`.
 * - `workflows`: defaults to ["pr-review"] (when registered). "build" is always
 *   excluded unless `allowBuild && allowWrite && hasApprovalLinks` (it is a
 *   write/approval workflow). Every resolved workflow id must be registered and
 *   carry a non-empty description, else this throws.
 * - `agents`: defaults to ["chat"] (when registered). Each must be registered.
 */
export function buildMcpSurface(args: {
  config: MacMcpConfig | undefined;
  workflows: Record<string, { description?: string }>;
  agents: Record<string, { description?: string } | unknown>;
  hasApprovalLinks: boolean;
}): MacMcpSurface {
  const { config, workflows, agents, hasApprovalLinks } = args;

  if (!config?.enabled) {
    return { enabled: false, toolGroups: [], workflows: [], agents: [] };
  }

  // --- Tool groups ---------------------------------------------------------
  const toolGroups: string[] = [];
  if (config.exposeReadTools !== false) toolGroups.push("github:read");
  if (config.allowWrite === true) toolGroups.push("github:review");

  // --- Workflows -----------------------------------------------------------
  const buildAllowed =
    config.allowBuild === true &&
    config.allowWrite === true &&
    hasApprovalLinks === true;

  const requestedWorkflows =
    config.exposeWorkflows ?? ["pr-review"].filter((id) => id in workflows);

  const resolvedWorkflows: string[] = [];
  for (const id of requestedWorkflows) {
    // "build" is a write/approval workflow — always excluded unless explicitly gated in.
    if (id === "build" && !buildAllowed) continue;

    const wf = workflows[id];
    if (!wf) {
      throw new Error(`MCP-exposed workflow "${id}" is not registered`);
    }
    if (!wf.description || wf.description.trim() === "") {
      throw new Error(
        `MCP-exposed workflow "${id}" must have a non-empty description`,
      );
    }
    resolvedWorkflows.push(id);
  }

  // --- Agents --------------------------------------------------------------
  const requestedAgents =
    config.exposeAgents ?? ["chat"].filter((id) => id in agents);

  const resolvedAgents: string[] = [];
  for (const id of requestedAgents) {
    if (!(id in agents)) {
      throw new Error(`MCP-exposed agent "${id}" is not registered`);
    }
    // Agent descriptions are not reliably readable from the registered instance
    // (no stable `description`/`getDescription` contract across Agent shapes),
    // so we require the id be registered and skip the description check for
    // agents. Workflows are the load-bearing MCP gate.
    resolvedAgents.push(id);
  }

  return {
    enabled: true,
    toolGroups,
    workflows: resolvedWorkflows,
    agents: resolvedAgents,
  };
}
