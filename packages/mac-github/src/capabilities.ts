/**
 * `@nearform/mac-github/capabilities` — the dependency-light type contract.
 *
 * Agent/workflow packages import `GithubCapabilities` and `githubCapabilities`
 * from here as a TYPE-LEVEL contract. Everything below is `import type` except
 * the `githubCapabilities` key itself (which pulls only `capabilityKey` from
 * `@nearform/mac/core`), so importing this module never loads Octokit, the
 * webhook crypto, or any env loader.
 */
import { capabilityKey } from "@nearform/mac/core";
import type { MacCapabilityKey, PlatformCapabilities } from "@nearform/mac/core";
import type { ApiRoute } from "@mastra/core/server";
import type { Octokit } from "octokit";
import type { GithubWebhookRouteArgs } from "./webhook.js";
import type { GitAccessProfile } from "./profiles.js";
import type { GithubReadTools } from "./tools.js";
import type { GithubReviewTools, ReviewEvent, PostedReview } from "./write-tools.js";
import type { ReactionContent, PostedComment } from "./issue-tools.js";

/** The only way reusable workflow code obtains a scoped installation token. */
export interface GithubTokenBroker {
  mint(profile: GitAccessProfile): Promise<{ token: string; expiresAt: string }>;
}

/** Mastra tools for agents during a session (built from a scoped token). */
export interface GithubTools {
  createReadTools(args: { token: string }): GithubReadTools;
  createReviewTools(args: { token: string }): GithubReviewTools;
}

/** Deterministic functions for workflow steps. */
export interface GithubFunctions {
  tokenBroker: GithubTokenBroker;
  createOctokit(args: { token: string }): Octokit;
  /** High-level: mint an issues-write token and post a reply comment. */
  replyOnIssue(args: { owner: string; repo: string; number: number; body: string }): Promise<void>;
  postPullRequestReview(
    octokit: Octokit,
    args: { owner: string; repo: string; number: number; event: ReviewEvent; body: string },
  ): Promise<PostedReview>;
  addIssueComment(
    octokit: Octokit,
    args: { owner: string; repo: string; number: number; body: string },
  ): Promise<PostedComment>;
  updateIssueComment(
    octokit: Octokit,
    args: { owner: string; repo: string; commentId: number; body: string },
  ): Promise<PostedComment>;
  addIssueReaction(
    octokit: Octokit,
    args: { owner: string; repo: string; number: number; content: ReactionContent },
  ): Promise<void>;
}

/**
 * Runtime processes / routes the preset can instantiate. The webhook route is
 * also exported standalone as `createGithubWebhookRoute`; this factory form is
 * for advanced/manual composition.
 */
export interface GithubServers {
  createWebhookRoute(args: GithubWebhookRouteArgs): ApiRoute;
}

/** Small descriptive values for routing / labels / auth checks / observability. */
export interface GithubMetadata {
  managedRepos: string[];
  botLogin: string;
}

export interface GithubCapabilities
  extends PlatformCapabilities<GithubTools, GithubFunctions, GithubServers, GithubMetadata> {}

export const githubCapabilities: MacCapabilityKey<GithubCapabilities> =
  capabilityKey<GithubCapabilities>("github", "GitHub platform");
