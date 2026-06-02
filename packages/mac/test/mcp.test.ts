import { describe, it, expect } from "vitest";
import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";

import { buildMcpSurface, createMacApp } from "../src/index.js";
import type { MacMcpConfig } from "../src/index.js";
import { defineAgent, defineWorkflow } from "../src/core/index.js";

// --- Fixtures --------------------------------------------------------------

const workflows = {
  "pr-review": { description: "Review a GitHub pull request and post the review." },
  build: { description: "Build and open a PR after approval." },
};
const agents = {
  chat: { description: "General chat agent." },
  reviewer: {},
};

function fakeAgent(): Agent {
  return { generate: async () => ({ text: "ok" }) } as unknown as Agent;
}
// Real Mastra Workflow instances carry `.description` (set from
// createWorkflow({ description })). The fake mirrors that so the surface
// gating, which reads the live registry, behaves as in production.
function fakeWorkflow(description: string): Workflow {
  return {
    description,
    createRun: async () => ({ start: async () => ({ status: "success" }) }),
  } as unknown as Workflow;
}

// --- buildMcpSurface -------------------------------------------------------

describe("buildMcpSurface — disabled", () => {
  it("returns an empty surface when config is undefined", () => {
    expect(
      buildMcpSurface({ config: undefined, workflows, agents, hasApprovalLinks: false }),
    ).toEqual({ enabled: false, toolGroups: [], workflows: [], agents: [] });
  });

  it("returns an empty surface when enabled is false", () => {
    expect(
      buildMcpSurface({
        config: { enabled: false },
        workflows,
        agents,
        hasApprovalLinks: true,
      }),
    ).toEqual({ enabled: false, toolGroups: [], workflows: [], agents: [] });
  });
});

describe("buildMcpSurface — enabled defaults", () => {
  it("exposes github:read, pr-review, and chat", () => {
    const surface = buildMcpSurface({
      config: { enabled: true },
      workflows,
      agents,
      hasApprovalLinks: false,
    });
    expect(surface.enabled).toBe(true);
    expect(surface.toolGroups).toEqual(["github:read"]);
    expect(surface.workflows).toEqual(["pr-review"]);
    expect(surface.agents).toEqual(["chat"]);
  });

  it("omits github:read when exposeReadTools is false", () => {
    const surface = buildMcpSurface({
      config: { enabled: true, exposeReadTools: false },
      workflows,
      agents,
      hasApprovalLinks: false,
    });
    expect(surface.toolGroups).toEqual([]);
  });
});

describe("buildMcpSurface — allowWrite", () => {
  it("adds github:review when allowWrite is true", () => {
    const surface = buildMcpSurface({
      config: { enabled: true, allowWrite: true },
      workflows,
      agents,
      hasApprovalLinks: false,
    });
    expect(surface.toolGroups).toEqual(["github:read", "github:review"]);
  });
});

describe("buildMcpSurface — build gating", () => {
  const withBuild: MacMcpConfig = {
    enabled: true,
    exposeWorkflows: ["pr-review", "build"],
  };

  it("excludes build by default even when explicitly listed", () => {
    const surface = buildMcpSurface({
      config: withBuild,
      workflows,
      agents,
      hasApprovalLinks: true,
    });
    expect(surface.workflows).toEqual(["pr-review"]);
  });

  it("excludes build when allowBuild+allowWrite but no approval links", () => {
    const surface = buildMcpSurface({
      config: { ...withBuild, allowBuild: true, allowWrite: true },
      workflows,
      agents,
      hasApprovalLinks: false,
    });
    expect(surface.workflows).toEqual(["pr-review"]);
  });

  it("includes build only when allowBuild && allowWrite && hasApprovalLinks", () => {
    const surface = buildMcpSurface({
      config: { ...withBuild, allowBuild: true, allowWrite: true },
      workflows,
      agents,
      hasApprovalLinks: true,
    });
    expect(surface.workflows).toEqual(["pr-review", "build"]);
  });
});

describe("buildMcpSurface — description validation", () => {
  it("throws when an exposed workflow lacks a description", () => {
    expect(() =>
      buildMcpSurface({
        config: { enabled: true, exposeWorkflows: ["empty"] },
        workflows: { empty: { description: "" } },
        agents,
        hasApprovalLinks: false,
      }),
    ).toThrow(/MCP-exposed workflow "empty" must have a non-empty description/);
  });

  it("throws when an exposed workflow is not registered", () => {
    expect(() =>
      buildMcpSurface({
        config: { enabled: true, exposeWorkflows: ["ghost"] },
        workflows,
        agents,
        hasApprovalLinks: false,
      }),
    ).toThrow(/MCP-exposed workflow "ghost" is not registered/);
  });

  it("throws when an exposed agent is not registered", () => {
    expect(() =>
      buildMcpSurface({
        config: { enabled: true, exposeAgents: ["ghost"] },
        workflows,
        agents,
        hasApprovalLinks: false,
      }),
    ).toThrow(/MCP-exposed agent "ghost" is not registered/);
  });
});

// --- Embedded path (host integration) --------------------------------------

describe("createMacApp — MCP opt-in", () => {
  it("yields an empty surface and empty mcpServers when mcp is unset", async () => {
    const preset = await createMacApp({
      model: "test/model",
      agents: [defineAgent({ id: "chat", description: "chat", create: () => fakeAgent() })],
      workflows: [
        defineWorkflow({
          id: "pr-review",
          description: "Review a PR.",
          create: () => fakeWorkflow("Review a PR."),
        }),
      ],
    });
    expect(preset.mcp.enabled).toBe(false);
    expect(preset.mcp).toEqual({
      enabled: false,
      toolGroups: [],
      workflows: [],
      agents: [],
    });
    expect(preset.mcpServers).toEqual({});
  });

  it("computes a gated surface from the final registries when enabled", async () => {
    const preset = await createMacApp({
      model: "test/model",
      mcp: { enabled: true },
      agents: [defineAgent({ id: "chat", description: "chat", create: () => fakeAgent() })],
      workflows: [
        defineWorkflow({
          id: "pr-review",
          description: "Review a PR.",
          create: () => fakeWorkflow("Review a PR."),
        }),
      ],
    });
    expect(preset.mcp).toEqual({
      enabled: true,
      toolGroups: ["github:read"],
      workflows: ["pr-review"],
      agents: ["chat"],
    });
    expect(preset.mcpServers).toEqual({});
  });
});
