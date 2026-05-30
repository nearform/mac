import { Agent } from "@mastra/core/agent";
import {
  createGithubReadTools,
  createInstallationOctokit,
  githubAppConfigFromEnv,
} from "@lastlight/github";
import { defaultModel } from "../config.js";
import { createChatMemory } from "../memory.js";
import { loadAgentContext } from "../agent-context.js";

/**
 * Chat agent — the in-process conversational surface, replacing lastlight's
 * `pi-ai` chat runner. Gets read-only GitHub tools + conversation memory.
 *
 * GitHub tools are attached only when GitHub App env is configured; without it
 * the agent still answers, just without repo access (keeps `mastra dev` usable
 * before secrets are wired).
 */
export function createChatAgent(): Agent {
  const persona = loadAgentContext();
  const instructions =
    (persona ? `${persona}\n\n---\n\n` : "") +
    [
      "You are operating as a chat assistant in a conversation thread.",
      "Use the github_* tools to look up real repository state before answering",
      "questions about issues, PRs, or code. Cite file paths and issue/PR numbers.",
      "If GitHub tools are unavailable, say so rather than guessing.",
    ].join(" ");

  // Attach read-only GitHub tools only if the App is configured AND the PEM is
  // readable. Never let an optional secret crash boot — the agent still runs
  // (just without repo access) so `mastra dev` works before secrets are wired.
  let tools: ReturnType<typeof createGithubReadTools> | Record<string, never> = {};
  const appConfig = githubAppConfigFromEnv();
  if (appConfig) {
    try {
      tools = createGithubReadTools(createInstallationOctokit(appConfig));
    } catch (err) {
      console.warn(
        `[chat] GitHub tools disabled — could not init App client: ${(err as Error).message}`,
      );
    }
  }

  return new Agent({
    id: "chat",
    name: "chat",
    instructions,
    model: defaultModel(),
    tools,
    memory: createChatMemory(),
  });
}
