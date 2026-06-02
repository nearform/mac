import { describe, it, expect, vi } from "vitest";
import { createBuildWorkflow, type BuildDeps } from "../src/index.js";

/**
 * Construction smoke test (NOT a behavior test) for the build workflow factory.
 * It guards the factory wiring/typing — that `createBuildWorkflow(deps)` returns
 * a workflow with id "build" — without exercising a real run (no real GitHub,
 * agents, sandbox, or approval links).
 */
describe("createBuildWorkflow", () => {
  it("returns a workflow whose id is 'build'", () => {
    const fakeDeps = {
      github: {
        functions: {
          tokenBroker: { mint: vi.fn() },
          createOctokit: vi.fn(),
          addIssueComment: vi.fn(),
          updateIssueComment: vi.fn(),
          addIssueReaction: vi.fn(),
        },
      },
      agents: { byId: () => ({}) as never },
      workspaceFactory: { create: () => ({}) as never },
      approvalLinks: { link: () => "http://x" },
    } as unknown as BuildDeps;

    const wf = createBuildWorkflow(fakeDeps);
    expect(wf.id).toBe("build");
  });
});
