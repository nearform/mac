import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import { RC_TOKEN, resolveWorkspace } from "./runtime.js";
import type { CodingAgentDeps } from "./types.js";

/**
 * The ARCHITECT (build phase 2).
 *
 * Runs against the pre-cloned checkout (cwd = repo root in its sandbox). It is
 * analysis-only: read the code + issue, produce an implementation PLAN as its
 * response text. It does NOT edit code, commit, push, or open PRs — the
 * workflow owns git, the executor owns the edits. The plan text becomes the
 * `post_architect` approval gate's payload and the executor's brief.
 *
 * REGISTERED agent so its LLM + tool calls trace to Studio. Its sandbox +
 * GitHub read tools are per-run, resolved dynamically from the requestContext
 * (taskId + token) the build step passes (see ./runtime.ts).
 */
export function createArchitectAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "architect",
    name: "architect",
    instructions: persona() + resolver.resolve("architect"),
    model: deps.model,
    tools: ({ requestContext }: { requestContext: RequestContext }) => {
      const token = requestContext.get(RC_TOKEN);
      return typeof token === "string" && token ? deps.createReadTools({ token }) : {};
    },
    workspace: ({ requestContext }: { requestContext: RequestContext }) =>
      resolveWorkspace(deps.workspaceFactory, requestContext),
    defaultOptions: { maxSteps: deps.maxSteps ?? 40 },
  });
}
