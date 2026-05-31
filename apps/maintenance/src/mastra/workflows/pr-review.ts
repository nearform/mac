import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import {
  createTokenOctokit,
  githubAppConfigFromEnv,
  mintTokenForProfile,
  postPullRequestReview,
  resolveProfile,
} from "@lastlight/github";
import { parseVerdict } from "../agents/reviewer.js";
import { buildAgentContext } from "../agents/runtime.js";
import { postMessage } from "../connectors/slack/notify.js";

/**
 * pr-review workflow — ported from lastlight `workflows/pr-review.yaml`.
 *
 * One step: mint a `review-write` token, run the review agent (read-only, with a
 * sandbox available) to get a VERDICT + body, then POST the review
 * deterministically from the workflow (not the agent) so a run never forgets to
 * post. github_post_review falls back to a COMMENT review if APPROVE/
 * REQUEST_CHANGES is rejected on the bot's own PR.
 */

const inputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive().describe("Pull request number."),
  // Slack reply target (set by dispatch when initiated from Slack) — when present
  // we post a "reviewing…" start and a verdict+link completion to the thread.
  slackChannel: z.string().optional(),
  slackThread: z.string().optional(),
});

const outputSchema = z.object({
  posted: z.boolean(),
  event: z.string(),
  reviewUrl: z.string().optional(),
  summary: z.string(),
});

const reviewStep = createStep({
  id: "review",
  inputSchema,
  outputSchema,
  execute: async ({ inputData, tracingContext, mastra }) => {
    const { owner, repo, number } = inputData;
    const ref = `${owner}/${repo}#${number}`;
    // Slack feedback target (the "reviewing…" start ack is posted by dispatch;
    // here we post only the verdict+link completion). null when not slack-initiated.
    const slackTarget =
      inputData.slackChannel && inputData.slackThread
        ? { channel: inputData.slackChannel, thread: inputData.slackThread }
        : null;

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
    const agent = mastra.getAgent("reviewer");

    const result = await agent.generate(
      `Review pull request ${owner}/${repo}#${number}. Fetch the diff, then ` +
        `produce your VERDICT line and review body.`,
      { requestContext: buildAgentContext(taskId, token), tracingContext },
    );

    const { event, body } = parseVerdict(result.text ?? "");

    // Post deterministically from the workflow (not via the agent's tool loop).
    const octokit = createTokenOctokit(token);
    const posted = await postPullRequestReview(octokit, { owner, repo, number, event, body });

    if (slackTarget) {
      const link = posted.url ? ` — ${posted.url}` : "";
      await postMessage(slackTarget, `✅ Review posted on ${ref}: **${event}**${link}`);
    }

    return {
      posted: true,
      event: posted.state || event,
      reviewUrl: posted.url,
      summary: `${event}\n\n${body}`.slice(0, 4000),
    };
  },
});

export const prReviewWorkflow = createWorkflow({
  id: "pr-review",
  inputSchema,
  outputSchema,
})
  .then(reviewStep)
  .commit();
