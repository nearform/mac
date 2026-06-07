import type { Command } from "commander";
import { parseGitHubRef } from "../lib/github.js";
import { post, assertServerRunning } from "../lib/server.js";

const SKILL_MAP: Record<string, string> = {
  triage: "issue-triage",
  health: "repo-health",
  security: "security-review",
};

function registerSkillCommand(program: Command, serverUrl: string, name: string, description: string): void {
  program
    .command(`${name} <ref>`)
    .description(description)
    .action(async (ref: string) => {
      const skill = SKILL_MAP[name]!;
      const parsed = parseGitHubRef(ref);
      const context = parsed
        ? { repo: `${parsed.owner}/${parsed.repo}`, issueNumber: parsed.number, sender: "cli" }
        : { repos: [ref], mode: "scan" };
      await assertServerRunning(serverUrl);
      console.log(`Triggering ${name} (${skill})...`);
      await post(serverUrl, "/cli/run", { skill, context });
    });
}

export function registerTriage(program: Command, serverUrl: string): void {
  registerSkillCommand(program, serverUrl, "triage", "Triage a GitHub issue");
  registerSkillCommand(program, serverUrl, "health", "Run a repo health check");
  registerSkillCommand(program, serverUrl, "security", "Run a security review");
}
