import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Octokit } from "octokit";

/**
 * GitHub WRITE tools as Mastra `createTool`s. Kept separate from the read-only
 * set (tools.ts) so a workflow can opt a phase into writes explicitly, and so
 * the Octokit handed here is expected to be authed with a token downscoped to
 * the right profile (e.g. `review-write` for posting reviews).
 */
export function createGithubReviewTools(octokit: Octokit) {
  const postReview = createTool({
    id: "github_post_review",
    description:
      "Submit a pull-request review. Use event COMMENT for neutral feedback, " +
      "APPROVE to approve, or REQUEST_CHANGES to block. Body is markdown.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive().describe("Pull request number."),
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string().describe("Review summary in markdown."),
    }),
    outputSchema: z.object({
      reviewId: z.number(),
      state: z.string(),
      url: z.string(),
    }),
    execute: async ({ owner, repo, number, event, body }) => {
      const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        event,
        body,
      });
      return {
        reviewId: data.id,
        state: data.state,
        url: data.html_url,
      };
    },
  });

  return { postReview };
}

export type GithubReviewTools = ReturnType<typeof createGithubReviewTools>;
