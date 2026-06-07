import { createWorkflow, createStep, type Workflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Agent } from "@mastra/core/agent";
import type { GithubCapabilities } from "@nearform/mac-github/capabilities";
import {
  defineWorkflow,
  splitRepo,
  slackOriginFromEnvelope,
  type MacWorkflowDefinition,
  type RouteContext,
} from "@nearform/mac/core";
import { githubCapabilities } from "@nearform/mac-github/capabilities";
import { slackCapabilities } from "@nearform/mac-slack/capabilities";
import { agentCapabilities } from "../capabilities.js";
import { parseVerdict } from "../parsers/verdict.js";
import { buildAgentContext } from "../agents/runtime.js";

/**
 * pr-review workflow factory — ported from the reference app's
 * `workflows/pr-review.ts` (MAC refactor Phase 7).
 *
 * One step: mint a `review-write` token via the injected GitHub token broker,
 * run the REGISTERED review agent (read-only, with a sandbox available) to get a
 * VERDICT + body, then POST the review deterministically from the workflow (not
 * the agent) so a run never forgets to post. The optional Slack capability lets
 * a Slack-initiated run post a verdict + link back to its thread.
 *
 * No env reads, no app-config knowledge: GitHub arrives as configured
 * capabilities, the reviewer as a registered instance, Slack as an optional
 * injected poster.
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

export interface PrReviewDeps {
  /** Configured GitHub capabilities — uses functions.tokenBroker / createOctokit / postPullRequestReview. */
  github: GithubCapabilities;
  /** The registered reviewer agent instance (traced), NOT a factory. */
  reviewer: Agent;
  /** Optional Slack poster — present when a Slack platform is configured. */
  postSlackMessage?: (
    target: { channel: string; thread: string },
    text: string,
  ) => Promise<void>;
}

/**
 * Skills the PR reviewer loads (per-step policy, owned here in the workflow).
 * The reviewer has a workspace, so these arrive as `skill`/`skill_read`/
 * `skill_search` tools scoped to just this set.
 */
const REVIEWER_SKILLS = ["github-code-review", "codebase-inspection"] as const;

export function createPrReviewWorkflow(deps: PrReviewDeps): Workflow {
  // A configured GitHub bundle always carries functions.
  const fns = deps.github.functions!;

  const reviewStep = createStep({
    id: "review",
    inputSchema,
    outputSchema,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      const { owner, repo, number } = inputData;
      const ref = `${owner}/${repo}#${number}`;
      logger.info(`[pr-review] ${ref} — reviewing pull request…`);
      // Slack feedback target (the "reviewing…" start ack is posted by dispatch;
      // here we post only the verdict+link completion). null when not slack-initiated.
      const slackTarget =
        inputData.slackChannel && inputData.slackThread
          ? { channel: inputData.slackChannel, thread: inputData.slackThread }
          : null;

      // Downscope to the profile pr-review maps to (review-write).
      const { token } = await fns.tokenBroker.mint("review-write");

      const taskId = `pr-review-${owner}-${repo}-${number}`;
      const result = await deps.reviewer.generate(
        `Review pull request ${owner}/${repo}#${number}. Fetch the diff, then ` +
          `produce your VERDICT line and review body.`,
        { requestContext: buildAgentContext(taskId, token, REVIEWER_SKILLS), tracingContext },
      );

      const { event, body } = parseVerdict(result.text ?? "");
      logger.info(`[pr-review] ${ref} — verdict ${event}; posting review…`);

      // Post deterministically from the workflow (not via the agent's tool loop).
      const octokit = fns.createOctokit({ token });
      const posted = await fns.postPullRequestReview(octokit, {
        owner,
        repo,
        number,
        event,
        body,
      });
      logger.info(
        `[pr-review] ${ref} — review posted: ${posted.state || event}${posted.url ? ` ${posted.url}` : ""}`,
      );

      if (slackTarget && deps.postSlackMessage) {
        const link = posted.url ? ` — ${posted.url}` : "";
        await deps.postSlackMessage(
          slackTarget,
          `✅ Review posted on ${ref}: **${event}**${link}`,
        );
      }

      return {
        posted: true,
        event: posted.state || event,
        reviewUrl: posted.url,
        summary: `${event}\n\n${body}`.slice(0, 4000),
      };
    },
  });

  return createWorkflow({
    id: "pr-review",
    description:
      "Review a GitHub pull request: mint a scoped token, run the reviewer agent for a VERDICT, then post the review deterministically.",
    inputSchema,
    outputSchema,
  })
    .then(reviewStep)
    .commit();
}

/**
 * The built-in `pr-review` workflow definition. The host resolves its `requires`
 * keys (GitHub + the agent registry) before `create()` runs, auto-enables the
 * `reviewer` agent transitively, and the optional Slack capability degrades to
 * "no Slack post" when no Slack platform is configured.
 */
/** Shape pr-review input from a route/intent context (deterministic PR event or Slack "review"). */
function prReviewInput(ctx: RouteContext): Record<string, unknown> {
  const parts = splitRepo(ctx.envelope.repo ?? ctx.classification?.repo);
  const number =
    ctx.envelope.prNumber ?? ctx.envelope.issueNumber ?? ctx.classification?.issueNumber;
  return {
    owner: parts?.owner ?? "",
    repo: parts?.repo ?? "",
    number,
    ...slackOriginFromEnvelope(ctx.envelope),
  };
}

export const prReviewWorkflowDefinition: MacWorkflowDefinition = defineWorkflow({
  id: "pr-review",
  description: "Review a GitHub pull request and post the review.",
  requires: [githubCapabilities, agentCapabilities],
  optional: [slackCapabilities],
  requiredAgents: ["reviewer"],
  // Deterministic: every PR-attention event gets a fresh review (the workflow's
  // "skip if already reviewed this SHA" guard covers the no-op case).
  routes: [
    {
      id: "github.pr_review",
      source: "github",
      eventTypes: ["pr.opened", "pr.synchronize", "pr.reopened"],
      target: { type: "workflow", id: "pr-review", input: prReviewInput },
    },
  ],
  // Classifier intent: a Slack "review <repo>#<n>" request (managed-repo gated).
  classifierIntents: [
    {
      id: "REVIEW",
      description:
        "Review pull requests on a repo — e.g. \"review acme/widgets#9\", \"check the PRs on <repo>\", \"can you review <repo>?\".",
      examples: [
        "review acme/widgets#12",
        "can you review PRs on cliftonc/lastlight?",
        "please review https://github.com/acme/widgets/pull/8",
      ],
      requires: { repo: true, managedRepo: true, issueNumber: true },
      target: { type: "workflow", id: "pr-review", input: prReviewInput },
    },
  ],
  create: ({ capabilities }) => {
    const github = capabilities.require(githubCapabilities);
    const agents = capabilities.require(agentCapabilities);
    const slack = capabilities.optional(slackCapabilities);
    return createPrReviewWorkflow({
      github,
      reviewer: agents.reviewer,
      postSlackMessage: slack?.functions?.postMessage,
    });
  },
});
