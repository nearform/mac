import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import {
  githubAppConfigFromEnv,
  mintTokenForProfile,
  resolveProfile,
} from "@lastlight/github";
import { createReviewAgent } from "../agents/reviewer.js";

/**
 * pr-review workflow — ported from lastlight `workflows/pr-review.yaml`.
 *
 * One step: mint a `review-write` token, build the review agent (read diff +
 * post review, with a sandbox available), and let it post exactly one review.
 * Multi-phase build (architect→executor→reviewer) comes in M4.
 */

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive().describe("Pull request number."),
});

const outputSchema = z.object({
  posted: z.boolean(),
  summary: z.string(),
});

const reviewStep = createStep({
  id: "review",
  inputSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    const { owner, repo, number } = inputData;

    const appConfig = githubAppConfigFromEnv();
    if (!appConfig) {
      throw new Error(
        "GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH).",
      );
    }

    // Downscope to the profile pr-review maps to (review-write).
    const profile = resolveProfile("pr-review");
    const { token } = await mintTokenForProfile(appConfig, profile);

    const taskId = `pr-review-${owner}-${repo}-${number}`;
    const agent = createReviewAgent({ token, taskId });

    const result = await agent.generate(
      `Review pull request ${owner}/${repo}#${number}. ` +
        `Fetch the diff, then post exactly one review via github_post_review ` +
        `(owner=${owner}, repo=${repo}, number=${number}).`,
    );

    const text = result.text ?? "";
    const posted = /github_post_review/.test(JSON.stringify(result.steps ?? [])) ||
      text.toLowerCase().includes("review");
    return { posted, summary: text.slice(0, 4000) };
  },
});

export const prReviewWorkflow = createWorkflow({
  id: "pr-review",
  inputSchema,
  outputSchema,
})
  .then(reviewStep)
  .commit();
