import type { MacExtension } from "@nearform/mac/core";
import type { GitHubAppConfig } from "./auth.js";
import { mintTokenForProfile } from "./auth.js";
import { createTokenOctokit } from "./client.js";
import { createGithubReadTools } from "./tools.js";
import { createGithubReviewTools, postPullRequestReview } from "./write-tools.js";
import { addIssueComment, updateIssueComment, addIssueReaction } from "./issue-tools.js";
import { createGithubWebhookRoute } from "./webhook.js";
import {
  githubCapabilities,
  type GithubCapabilities,
  type GithubTokenBroker,
} from "./capabilities.js";

/**
 * Configuration for the `github()` extension. This is where GitHub App config
 * enters the system — reusable workflow/agent code never reads it; they consume
 * the configured capabilities through the registry.
 */
export interface GithubConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
  /** Repos this app is allowed to operate on. */
  managedRepos?: string[];
  /** Bot login used for webhook self-event filtering (Phase 3). */
  botLogin?: string;
  /** Webhook HMAC secret (used by the webhook route in Phase 3). */
  webhookSecret?: string;
}

/**
 * The GitHub platform extension. In Phase 1 it publishes the GitHub capability
 * bundle (tools / functions / metadata) into the registry. The inbound webhook
 * route + `servers` surface are added in Phase 3.
 */
export function github(config: GithubConfig): MacExtension {
  const appConfig: GitHubAppConfig = {
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPath: config.privateKeyPath,
  };

  const tokenBroker: GithubTokenBroker = {
    mint: (profile) => mintTokenForProfile(appConfig, profile),
  };

  const bundle: GithubCapabilities = {
    tools: {
      createReadTools: ({ token }) => createGithubReadTools(createTokenOctokit(token)),
      createReviewTools: ({ token }) => createGithubReviewTools(createTokenOctokit(token)),
    },
    functions: {
      tokenBroker,
      createOctokit: ({ token }) => createTokenOctokit(token),
      async replyOnIssue({ owner, repo, number, body }) {
        const { token } = await tokenBroker.mint("issues-write");
        await addIssueComment(createTokenOctokit(token), { owner, repo, number, body });
      },
      postPullRequestReview,
      addIssueComment,
      updateIssueComment,
      addIssueReaction,
    },
    servers: {
      createWebhookRoute: createGithubWebhookRoute,
    },
    metadata: {
      managedRepos: config.managedRepos ?? [],
      botLogin: config.botLogin ?? "",
    },
  };

  return {
    name: "github",
    provides: [githubCapabilities],
    init(context) {
      context.capabilities.provide(githubCapabilities, bundle);
      if (!config.webhookSecret) {
        return {};
      }
      return {
        apiRoutes: [
          createGithubWebhookRoute({
            webhookSecret: config.webhookSecret,
            botLogin: config.botLogin ?? "",
            isManagedRepo: (r) => !!r && (config.managedRepos ?? []).includes(r),
            replyOnIssue: (owner, repo, issueNumber, body) =>
              bundle.functions!.replyOnIssue({ owner, repo, number: issueNumber, body }),
            createDispatch: () => context.dispatch,
          }),
        ],
      };
    },
  };
}
