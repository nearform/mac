import type { Command } from "commander";
import { parseGitHubRef } from "../lib/github.js";
import { post, assertServerRunning } from "../lib/server.js";

export function registerBuild(program: Command, serverUrl: string): void {
  program
    .command("build <ref>")
    .description("Run the full build cycle (architect → executor → reviewer → PR)")
    .action(async (ref: string) => {
      const parsed = parseGitHubRef(ref);
      if (!parsed) {
        console.error(`Usage: mac build <github-url> | <owner/repo#N>`);
        process.exit(1);
      }
      await assertServerRunning(serverUrl);
      const { owner, repo, number } = parsed;
      console.log(`Triggering BUILD cycle for ${owner}/${repo}#${number}...`);
      await post(serverUrl, "/cli/build", { owner, repo, issueNumber: number });
    });
}
