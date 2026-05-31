import type { Octokit } from "octokit";

/**
 * Issue write helpers used by the build workflow to make the source issue a live
 * progress surface: one status comment that is created once and then EDITED as
 * each phase completes, plus reactions (🚀 on build start). Kept as plain
 * functions (not Mastra tools) because the workflow calls them deterministically.
 */

export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface PostedComment {
  id: number;
  url: string;
}

/** Create a new comment on an issue; returns its id so it can be edited later. */
export async function addIssueComment(
  octokit: Octokit,
  args: { owner: string; repo: string; number: number; body: string },
): Promise<PostedComment> {
  const { data } = await octokit.rest.issues.createComment({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.number,
    body: args.body,
  });
  return { id: data.id, url: data.html_url };
}

/** Edit an existing issue comment in place (the live status comment). */
export async function updateIssueComment(
  octokit: Octokit,
  args: { owner: string; repo: string; commentId: number; body: string },
): Promise<PostedComment> {
  const { data } = await octokit.rest.issues.updateComment({
    owner: args.owner,
    repo: args.repo,
    comment_id: args.commentId,
    body: args.body,
  });
  return { id: data.id, url: data.html_url };
}

/** React to an issue (e.g. 🚀 on build start). Idempotent server-side per user. */
export async function addIssueReaction(
  octokit: Octokit,
  args: { owner: string; repo: string; number: number; content: ReactionContent },
): Promise<void> {
  await octokit.rest.reactions.createForIssue({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.number,
    content: args.content,
  });
}
