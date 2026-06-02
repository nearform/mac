import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Octokit } from "octokit";

/**
 * Read-only GitHub tools as Mastra `createTool`s, ported in spirit from
 * the original `src/engine/github-tools.ts` (the chat agent's read-only toolset).
 * A factory closes over an authenticated Octokit so the same tool defs work
 * with either an App-installation client or a downscoped token client.
 *
 * Read-only by design: no create/update/merge here. Write tools (post comment,
 * review, open PR) arrive with the pr-review / build workflows (M3+).
 */
export function createGithubReadTools(octokit: Octokit) {
  const readFile = createTool({
    id: "github_read_file",
    description:
      "Read the contents of a file from a GitHub repository at an optional ref (branch/tag/SHA).",
    inputSchema: z.object({
      owner: z.string().describe("Repository owner (user or org)."),
      repo: z.string().describe("Repository name."),
      path: z.string().describe("File path within the repo."),
      ref: z.string().optional().describe("Branch, tag, or commit SHA. Defaults to the default branch."),
    }),
    outputSchema: z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
    }),
    execute: async ({ owner, repo, path, ref }) => {
      const res = await octokit.rest.repos.getContent({ owner, repo, path, ref });
      const data = res.data as { type?: string; content?: string; encoding?: string };
      if (Array.isArray(res.data) || data.type !== "file" || typeof data.content !== "string") {
        throw new Error(`Path is not a file: ${path}`);
      }
      const decoded = Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf-8");
      const MAX = 60_000;
      return {
        path,
        content: decoded.length > MAX ? decoded.slice(0, MAX) : decoded,
        truncated: decoded.length > MAX,
      };
    },
  });

  const getIssue = createTool({
    id: "github_get_issue",
    description: "Fetch a single issue or pull request (title, body, state, labels, author).",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    outputSchema: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      state: z.string(),
      author: z.string(),
      labels: z.array(z.string()),
      isPullRequest: z.boolean(),
    }),
    execute: async ({ owner, repo, number }) => {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        state: data.state,
        author: data.user?.login ?? "unknown",
        labels: data.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
        isPullRequest: Boolean(data.pull_request),
      };
    },
  });

  const listIssueComments = createTool({
    id: "github_list_issue_comments",
    description: "List all comments on an issue or PR, oldest first.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    outputSchema: z.object({
      comments: z.array(z.object({ author: z.string(), body: z.string(), createdAt: z.string() })),
    }),
    execute: async ({ owner, repo, number }) => {
      const data = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });
      return {
        comments: data.map((c) => ({
          author: c.user?.login ?? "unknown",
          body: c.body ?? "",
          createdAt: c.created_at,
        })),
      };
    },
  });

  const searchIssues = createTool({
    id: "github_search_issues",
    description:
      "Search issues and pull requests using GitHub search syntax (e.g. 'repo:owner/name is:open label:bug').",
    inputSchema: z.object({
      query: z.string().describe("GitHub issue search query."),
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
    outputSchema: z.object({
      total: z.number(),
      items: z.array(
        z.object({ number: z.number(), title: z.string(), state: z.string(), url: z.string() }),
      ),
    }),
    execute: async ({ query, limit }) => {
      const { data } = await octokit.rest.search.issuesAndPullRequests({ q: query, per_page: limit });
      return {
        total: data.total_count,
        items: data.items.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
        })),
      };
    },
  });

  const getPullRequestDiff = createTool({
    id: "github_get_pull_request_diff",
    description: "Fetch the unified diff for a pull request.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    }),
    outputSchema: z.object({ diff: z.string(), truncated: z.boolean() }),
    execute: async ({ owner, repo, number }) => {
      const res = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
        mediaType: { format: "diff" },
      });
      const diff = res.data as unknown as string;
      const MAX = 80_000;
      return {
        diff: diff.length > MAX ? diff.slice(0, MAX) : diff,
        truncated: diff.length > MAX,
      };
    },
  });

  return { readFile, getIssue, listIssueComments, searchIssues, getPullRequestDiff };
}

export type GithubReadTools = ReturnType<typeof createGithubReadTools>;
