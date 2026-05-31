import { Agent } from "@mastra/core/agent";
import { agentMaxSteps, defaultModel } from "../config.js";
import { loadAgentContext } from "../agent-context.js";
import { workspaceFromContext } from "./runtime.js";

const GIT_RULES = [
  "HARD RULES: do NOT run git commit, git push, or open a pull request, and do",
  "NOT change the git remote. The workflow owns version control and will diff",
  "your working-tree changes. Just edit files and leave them in the working tree.",
].join("\n");

const DEPS_NOTE = [
  "You may install dependencies and bring up service deps inside your sandbox",
  "via execute_command — e.g. `npm install` / `pnpm install`, or",
  "`docker compose up -d` to start databases the tests need. Tear down compose",
  "deps (`docker compose down`) when you're done if you started them.",
].join("\n");

function persona(): string {
  const p = loadAgentContext();
  return p ? `${p}\n\n---\n\n` : "";
}

/**
 * The EXECUTOR (build phase 4). Adapted from lastlight `prompts/executor.md`.
 *
 * Implements the architect's plan by editing files in the shared checkout and
 * running the project's tests/lint/typecheck inside its sandbox. It does NOT
 * touch git — the workflow captures the working-tree diff. The plan is passed
 * in the prompt (see workflows/build.ts).
 *
 * REGISTERED agent (index.ts) so its tool calls trace to Studio; its sandbox is
 * the per-run checkout, resolved from the requestContext taskId (agents/runtime.ts).
 */
export const executorAgent = new Agent({
  id: "executor",
  name: "executor",
  instructions:
    persona() +
    [
      "You are the EXECUTOR. Implement precisely what the architect's plan requires.",
      "Your sandbox cwd is the repo checkout root.",
      "",
      "- Follow TDD where practical: write a failing test, implement, verify.",
      "- Edit files with your file tools.",
      DEPS_NOTE,
      "",
      "BEFORE YOU FINISH — all guardrails must pass:",
      "1. Run the test command; ALL tests must pass (zero failures).",
      "2. Run the lint command (if present) and fix all lint errors.",
      "3. Run the typecheck command (if present) and fix all type errors.",
      "Re-run until clean.",
      "",
      GIT_RULES,
      "",
      "Finish with a concise summary: files changed, and the actual",
      "test / lint / typecheck output you observed.",
    ].join("\n"),
  model: defaultModel(),
  workspace: workspaceFromContext,
  defaultOptions: { maxSteps: agentMaxSteps() },
});

/**
 * The FIX agent (build reviewer fix-loop). Adapted from lastlight
 * `prompts/fix.md`. Same sandbox/checkout as the executor, but narrowly scoped:
 * fix ONLY the issues the reviewer raised (passed in the prompt), re-run
 * guardrails, and stop. No git.
 */
export const fixAgent = new Agent({
  id: "fix",
  name: "fix",
  instructions:
    persona() +
    [
      "You are the EXECUTOR in a fix cycle. Fix ONLY the issues the reviewer",
      "reported (provided in the prompt) — do not expand scope.",
      "Your sandbox cwd is the repo checkout root.",
      "",
      DEPS_NOTE,
      "",
      "BEFORE YOU FINISH — all guardrails must pass (tests, then lint, then",
      "typecheck); re-run until clean.",
      "",
      GIT_RULES,
      "",
      "Finish with a concise summary of what you fixed and the test/lint/typecheck output.",
    ].join("\n"),
  model: defaultModel(),
  workspace: workspaceFromContext,
  defaultOptions: { maxSteps: agentMaxSteps() },
});
