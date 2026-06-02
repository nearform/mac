import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import { RC_TOKEN, resolveWorkspace } from "./runtime.js";
import type { CodingAgentDeps } from "./types.js";

/**
 * The PR-review agent. Read-only: it fetches the diff (and reads files / runs
 * commands in its sandbox if needed) and PRODUCES a verdict — it does NOT post.
 * The workflow step posts the review deterministically, mirroring the
 * reviewer-emits-verdict / orchestrator-acts split, so a run never silently
 * "forgets" to post.
 *
 * REGISTERED agent so its tool calls trace to Studio; sandbox + read tools are
 * per-run, resolved from the requestContext (taskId + token) via injected deps.
 *
 * Output contract: stdout MUST begin with a line `VERDICT: APPROVE` |
 * `VERDICT: REQUEST_CHANGES` | `VERDICT: COMMENT`, then the markdown review body.
 */
export function createReviewerAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "reviewer",
    name: "reviewer",
    instructions: persona() + resolver.resolve("reviewer"),
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

/**
 * The BUILD reviewer (build phase 5). Unlike the PR reviewer above, there is no
 * PR yet — the change lives only as a working-tree diff in the build checkout.
 * So this reviewer is given the diff (and the architect's plan) directly in the
 * prompt and judges it. Read-only, no tools, no workspace: deterministic input,
 * deterministic VERDICT out (parsed by `parseVerdict`, reused by the fix-loop).
 * Still REGISTERED so its LLM call traces to Studio.
 */
export function createBuildReviewerAgent(deps: CodingAgentDeps): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "build-reviewer",
    name: "build-reviewer",
    instructions: persona() + resolver.resolve("build-reviewer"),
    model: deps.model,
  });
}
