import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import { RC_TASK_ID } from "./runtime.js";
import type { CodingAgentDeps } from "./types.js";

/**
 * The EXECUTOR (build phase 4).
 *
 * Implements the architect's plan by editing files in the shared checkout and
 * running the project's tests/lint/typecheck inside its sandbox. It does NOT
 * touch git — the workflow captures the working-tree diff. The plan is passed
 * in the prompt (see the build workflow).
 *
 * REGISTERED agent so its tool calls trace to Studio; its sandbox is the per-run
 * checkout, resolved from the requestContext taskId (see ./runtime.ts).
 */
export function createExecutorAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "executor",
    name: "executor",
    instructions: persona() + resolver.resolve("executor"),
    model: deps.model,
    workspace: ({ requestContext }: { requestContext: RequestContext }) => {
      const taskId = requestContext.get(RC_TASK_ID);
      return typeof taskId === "string" && taskId
        ? deps.workspaceFactory.create(taskId)
        : undefined;
    },
    defaultOptions: { maxSteps: deps.maxSteps ?? 40 },
  });
}

/**
 * The FIX agent (build reviewer fix-loop). Same sandbox/checkout as the
 * executor, but narrowly scoped: fix ONLY the issues the reviewer raised (passed
 * in the prompt), re-run guardrails, and stop. No git.
 */
export function createFixAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "fix",
    name: "fix",
    instructions: persona() + resolver.resolve("fix"),
    model: deps.model,
    workspace: ({ requestContext }: { requestContext: RequestContext }) => {
      const taskId = requestContext.get(RC_TASK_ID);
      return typeof taskId === "string" && taskId
        ? deps.workspaceFactory.create(taskId)
        : undefined;
    },
    defaultOptions: { maxSteps: deps.maxSteps ?? 40 },
  });
}
