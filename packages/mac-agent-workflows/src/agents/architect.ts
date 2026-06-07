import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import { resolveWorkspace } from "./runtime.js";
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
 * Tools: WORKSPACE-ONLY (read_file/list_files/grep over the local checkout). It
 * deliberately gets NO GitHub read tools — those duplicate the workspace file
 * tools (two ways to read the same files) and weaker models churn between them
 * instead of converging on the plan (observed: a read-loop that exhausted the
 * step budget and returned an empty plan). The checkout is already on disk, so
 * the workspace tools are sufficient. (The executor is wired the same way.)
 *
 * REGISTERED agent so its LLM + tool calls trace to Studio; its sandbox is the
 * per-run checkout, resolved from the requestContext taskId (see ./runtime.ts).
 */
export function createArchitectAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "architect",
    name: "architect",
    instructions: persona() + resolver.resolve("architect"),
    model: deps.model,
    workspace: ({ requestContext }: { requestContext: RequestContext }) =>
      resolveWorkspace(deps.workspaceFactory, requestContext),
    defaultOptions: { maxSteps: deps.maxSteps ?? 40 },
  });
}
