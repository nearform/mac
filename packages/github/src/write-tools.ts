import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Octokit } from "octokit";

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PostedReview {
  reviewId: number;
  state: string;
  url: string;
}

/**
 * Submit a PR review, with a COMMENT fallback. GitHub forbids APPROVE/
 * REQUEST_CHANGES on your own PR (the bot frequently authors the PR it reviews),
 * so on that specific rejection we re-post as a COMMENT review — the assessment
 * still lands instead of failing the run. Used by both the workflow (preferred,
 * deterministic) and the `github_post_review` tool.
 */
export async function postPullRequestReview(
  octokit: Octokit,
  args: { owner: string; repo: string; number: number; event: ReviewEvent; body: string },
): Promise<PostedReview> {
  const { owner, repo, number, event, body } = args;
  let data;
  try {
    ({ data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      event,
      body,
    }));
  } catch (err) {
    const msg = (err as { message?: string }).message ?? "";
    if (event !== "COMMENT" && /can not (approve|request changes)|your own pull request/i.test(msg)) {
      const note = `> _Posting as a comment: ${event} isn't permitted on the bot's own PR._\n\n`;
      ({ data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: number,
        event: "COMMENT",
        body: note + body,
      }));
    } else {
      throw err;
    }
  }
  return { reviewId: data.id, state: data.state, url: data.html_url };
}

/**
 * GitHub WRITE tools as Mastra `createTool`s. Kept separate from the read-only
 * set (tools.ts) so a workflow can opt a phase into writes explicitly, and so
 * the Octokit handed here is expected to be authed with a token downscoped to
 * the right profile (e.g. `review-write`).
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
    execute: async ({ owner, repo, number, event, body }) =>
      postPullRequestReview(octokit, { owner, repo, number, event, body }),
  });

  return { postReview };
}

export type GithubReviewTools = ReturnType<typeof createGithubReviewTools>;
