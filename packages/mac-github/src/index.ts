/**
 * `@nearform/mac-github` — GitHub platform package (full runtime API).
 *
 * Owns App auth, permission profiles, Octokit factories, read/write Mastra
 * tools, issue/PR helpers, and the `github()` extension. The dependency-light
 * type contract (`GithubCapabilities`/`githubCapabilities`) is published
 * separately from `@nearform/mac-github/capabilities`.
 */

// Permission profiles (the security boundary)
export {
  type GitAccessProfile,
  type GitHubPermissionLevel,
  type GitHubTokenPermissions,
  GITHUB_PERMISSION_PROFILES,
  resolveProfile,
} from "./profiles.js";

// App auth / token broker
export {
  type GitHubAppConfig,
  type InstallationToken,
  mintInstallationToken,
  mintTokenForProfile,
  githubAppConfigFromEnv,
} from "./auth.js";

// Octokit clients
export { createInstallationOctokit, createTokenOctokit } from "./client.js";

// Read-only Mastra tools (agent session surface)
export { createGithubReadTools, type GithubReadTools } from "./tools.js";

// Write helpers — kept separate from the read tools so callers opt into write
// scope intentionally (review submission).
export {
  createGithubReviewTools,
  type GithubReviewTools,
  postPullRequestReview,
  type ReviewEvent,
  type PostedReview,
} from "./write-tools.js";

// Issue write helpers (deterministic, workflow-facing)
export {
  addIssueComment,
  updateIssueComment,
  addIssueReaction,
  type ReactionContent,
  type PostedComment,
} from "./issue-tools.js";

// GitHub webhook connector (signature verify / filter / normalize + route factory)
export {
  createGithubWebhookRoute,
  type GithubWebhookRouteArgs,
  normalizeGithubEvent,
  verifySignature,
  isFilteredBotEvent,
  IGNORED_ACTIONS,
} from "./webhook.js";

// The github() extension + its config
export { github, type GithubConfig } from "./extension.js";

// Re-export the capability contract for convenience (also available, dependency
// -light, from "@nearform/mac-github/capabilities").
export {
  githubCapabilities,
  type GithubCapabilities,
  type GithubTokenBroker,
  type GithubTools,
  type GithubFunctions,
  type GithubServers,
  type GithubMetadata,
} from "./capabilities.js";
