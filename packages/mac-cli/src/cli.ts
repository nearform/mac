#!/usr/bin/env tsx

import { Command } from "commander";
import { registerBuild } from "./commands/build.js";
import { registerReview } from "./commands/review.js";
import { registerTriage } from "./commands/triage.js";
import { registerDev } from "./commands/dev.js";
import { parseGitHubRef } from "./lib/github.js";
import { post, assertServerRunning } from "./lib/server.js";
import { printBanner } from "./lib/banner.js";

const SERVER_URL = process.env.MAC_URL ?? "http://localhost:4111";

const program = new Command();

program
  .name("mac")
  .description("MAC — Mastra Agentic Coding")
  .version("0.0.0")
  .addHelpText(
    "after",
    `
Examples:
  mac dev                          Start server + Studio in dev mode
  mac build owner/repo#42          Run the full build cycle for issue #42
  mac review owner/repo#7          Review PR #7
  mac owner/repo#42                Triage issue or review PR (auto-detected)
  mac https://github.com/org/repo/issues/42`,
  );

// Subcommands
registerBuild(program, SERVER_URL);
registerReview(program, SERVER_URL);
registerTriage(program, SERVER_URL);
registerDev(program);

// Default: bare <ref> → triage or review based on ref type
program
  .argument("[ref]", "GitHub issue or PR (url or owner/repo#N)")
  .action(async (ref: string | undefined) => {
    if (!ref) {
      printBanner({ clearScreen: false, subtitle: "" });
      process.stdout.write(program.helpInformation());
      process.exit(0);
    }
    const parsed = parseGitHubRef(ref);
    if (!parsed) {
      console.error(`Could not parse GitHub reference: ${ref}`);
      console.error(`Expected: https://github.com/owner/repo/issues/N or owner/repo#N`);
      console.error(`For a full build cycle: mac build ${ref}`);
      process.exit(1);
    }
    await assertServerRunning(SERVER_URL);
    const { owner, repo, number, type } = parsed;
    const isPr = type === "pr";
    console.log(`Triggering ${isPr ? "PR review" : "issue triage"} for ${owner}/${repo}#${number}...`);
    if (!isPr) console.log(`(For a full build cycle: mac build ${owner}/${repo}#${number})`);
    await post(SERVER_URL, "/cli/run", {
      skill: isPr ? "pr-review" : "issue-triage",
      context: {
        repo: `${owner}/${repo}`,
        ...(isPr ? { prNumber: number } : { issueNumber: number }),
        sender: "cli",
      },
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
