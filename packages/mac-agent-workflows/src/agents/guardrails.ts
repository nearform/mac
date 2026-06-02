import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import { RC_TASK_ID } from "./runtime.js";
import type { CodingAgentDeps } from "./types.js";

/**
 * The GUARDRAILS check (build phase 1). Trimmed to the pre-flight detection:
 * confirm the checkout has a working test runner (and note lint/typecheck), so
 * later phases can actually verify their work. Analysis-only; the workflow
 * parses the READY / BLOCKED marker (see the build workflow) and decides whether
 * to gate.
 *
 * REGISTERED agent so its tool calls trace to Studio. Its sandbox is the per-run
 * checkout, resolved dynamically from the requestContext taskId. It has the
 * sandbox so it can actually invoke the project's test command rather than
 * guessing from config.
 */
export function createGuardrailsAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "guardrails",
    name: "guardrails",
    instructions: persona() + resolver.resolve("guardrails"),
    model: deps.model,
    workspace: ({ requestContext }: { requestContext: RequestContext }) => {
      const taskId = requestContext.get(RC_TASK_ID);
      return typeof taskId === "string" && taskId
        ? deps.workspaceFactory.create(taskId)
        : undefined;
    },
    // Enough tool-loop budget to install deps + run test/lint/typecheck and
    // still emit the final GUARDRAILS: marker (Mastra's default of 5 is too low).
    defaultOptions: { maxSteps: deps.maxSteps ?? 40 },
  });
}
