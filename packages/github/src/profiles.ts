/**
 * GitHub App installation-token permission profiles.
 *
 * Ported verbatim from lastlight `src/engine/profiles.ts`. Each workflow maps
 * to exactly one profile; the token broker (./auth.ts) mints a per-run
 * installation token downscoped to these permissions. This is the single most
 * important security boundary: a triage agent literally cannot push code
 * because its token has contents:read.
 */
export type GitAccessProfile = "read" | "issues-write" | "review-write" | "repo-write";

export type GitHubPermissionLevel = "read" | "write";

export type GitHubTokenPermissions = Partial<{
  contents: GitHubPermissionLevel;
  issues: GitHubPermissionLevel;
  pull_requests: GitHubPermissionLevel;
  metadata: GitHubPermissionLevel;
}>;

export const GITHUB_PERMISSION_PROFILES: Record<GitAccessProfile, GitHubTokenPermissions> = {
  read: {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
  "issues-write": {
    contents: "read",
    issues: "write",
    pull_requests: "read",
    metadata: "read",
  },
  "review-write": {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  "repo-write": {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
};

const WORKFLOW_PROFILES: Record<string, GitAccessProfile> = {
  "issue-triage": "issues-write",
  triage: "issues-write",
  "pr-review": "review-write",
  review: "review-write",
  "pr-comment": "review-write",
  "issue-comment": "issues-write",
  build: "repo-write",
  "pr-fix": "repo-write",
  explore: "repo-write",
  "repo-health": "issues-write",
};

/** Resolve the permission profile for a workflow; defaults to `read`. */
export function resolveProfile(workflowName: string): GitAccessProfile {
  return WORKFLOW_PROFILES[workflowName] ?? "read";
}
