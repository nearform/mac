export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
  type: "pr" | "issue";
}

export function parseGitHubRef(input: string | undefined): GitHubRef | null {
  if (!input) return null;
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!,
      number: parseInt(urlMatch[4]!, 10),
      type: urlMatch[3] === "pull" ? "pr" : "issue",
    };
  }
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
      type: "issue",
    };
  }
  return null;
}
