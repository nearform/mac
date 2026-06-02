import { describe, it, expect } from "vitest";

/**
 * Prompt-composition contract guards — NOT golden snapshots.
 *
 * The agent instructions are externalized to markdown behind the PromptResolver.
 * These assertions pin only each agent's critical OUTPUT-CONTRACT markers (the
 * strings downstream parsers / workflows depend on) plus a non-empty check. They
 * guard against the markdown drifting away from the behavior the code relies on,
 * without freezing the full prose.
 *
 * Phase 6b — relocated here from the app so the guard tests the PACKAGE
 * factories directly, not app instance shims. Each agent is constructed with a
 * minimal fake deps object; instructions are static markdown, so no model/tools
 * are exercised.
 */

import {
  createChatAgent,
  createReviewerAgent,
  createBuildReviewerAgent,
  createArchitectAgent,
  createExecutorAgent,
  createFixAgent,
  createGuardrailsAgent,
} from "../src/index.js";

const codingDeps = {
  model: "openai/gpt-4o",
  workspaceFactory: { create: () => ({}) as any },
  createReadTools: () => ({}),
};

function instructionsOf(agent: { getInstructions(): unknown }): string {
  return String(agent.getInstructions());
}

describe("externalized agent instructions — output-contract markers", () => {
  it("chat references the github_* tools", () => {
    const text = instructionsOf(createChatAgent({ model: "openai/gpt-4o" }));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("github_*");
  });

  it("reviewer emits the VERDICT contract", () => {
    const text = instructionsOf(createReviewerAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("VERDICT: APPROVE");
    expect(text).toContain("VERDICT: REQUEST_CHANGES");
    expect(text).toContain("VERDICT: COMMENT");
  });

  it("build-reviewer emits the VERDICT contract", () => {
    const text = instructionsOf(createBuildReviewerAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("VERDICT: APPROVE");
  });

  it("guardrails emits the READY / BLOCKED contract", () => {
    const text = instructionsOf(createGuardrailsAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("GUARDRAILS: READY");
    expect(text).toContain("GUARDRAILS: BLOCKED");
  });

  it("architect names itself and emits the complexity estimate section", () => {
    const text = instructionsOf(createArchitectAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("ARCHITECT");
    expect(text).toContain("Estimated complexity");
  });

  it("executor names itself and gates on finishing", () => {
    const text = instructionsOf(createExecutorAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("EXECUTOR");
    expect(text).toContain("BEFORE YOU FINISH");
  });

  it("fix agent is scoped to the reviewer fix cycle", () => {
    const text = instructionsOf(createFixAgent(codingDeps));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("fix cycle");
  });
});
