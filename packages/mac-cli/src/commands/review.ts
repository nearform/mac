import type { Command } from "commander";
import { parseGitHubRef } from "../lib/github.js";
import { post, assertServerRunning } from "../lib/server.js";

export function registerReview(program: Command, serverUrl: string): void {
  program
    .command("review <ref>")
    .description("Trigger a PR review")
    .action(async (ref: string) => {
      const parsed = parseGitHubRef(ref);
      if (!parsed) {
        console.error(`Usage: mac review <owner/repo#N> | <pr-url>`);
        process.exit(1);
      }
      await assertServerRunning(serverUrl);
      const { owner, repo, number } = parsed;
      console.log(`Triggering PR review for ${owner}/${repo}#${number}...`);
      await post(serverUrl, "/cli/run", {
        skill: "pr-review",
        context: { repo: `${owner}/${repo}`, prNumber: number },
      });
    });
}
