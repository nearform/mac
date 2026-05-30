import { Agent } from "@mastra/core/agent";
import {
  createGithubReadTools,
  createGithubReviewTools,
  createTokenOctokit,
} from "@lastlight/github";
import { defaultModel } from "../config.js";
import { loadAgentContext } from "../agent-context.js";
import { createCodeWorkspace } from "../workspace.js";

export interface ReviewAgentOptions {
  /** Installation token, downscoped to `review-write`. */
  token: string;
  /** Task id → isolated sandbox checkout dir. */
  taskId: string;
}

/**
 * The PR-review agent. Built per-run with a downscoped token so its octokit
 * (read tools + post-review write tool) can only do what `review-write` allows,
 * and a Workspace sandbox so it can clone + inspect the code if needed.
 *
 * Mirrors lastlight's pr-review phase: read the diff, reason, post one review.
 */
export function createReviewAgent({ token, taskId }: ReviewAgentOptions): Agent {
  const octokit = createTokenOctokit(token);
  const readTools = createGithubReadTools(octokit);
  const reviewTools = createGithubReviewTools(octokit);
  const persona = loadAgentContext();

  const instructions =
    (persona ? `${persona}\n\n---\n\n` : "") +
    [
      "You are performing a pull-request review.",
      "1. Fetch the PR diff with github_get_pull_request_diff.",
      "2. Read surrounding files with github_read_file if you need context.",
      "3. Organise findings as: critical > important > suggestions > nits.",
      "4. Post EXACTLY ONE review with github_post_review:",
      "   - REQUEST_CHANGES if there are critical/important issues,",
      "   - APPROVE if it's clean,",
      "   - COMMENT otherwise.",
      "Be concise and cite file:line. Do not post multiple reviews.",
    ].join("\n");

  return new Agent({
    id: "reviewer",
    name: "reviewer",
    instructions,
    model: defaultModel(),
    tools: { ...readTools, ...reviewTools },
    workspace: createCodeWorkspace(taskId),
  });
}
