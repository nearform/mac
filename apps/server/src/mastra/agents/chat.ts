import type { Agent } from "@mastra/core/agent";
import {
  createGithubReadTools,
  createInstallationOctokit,
  githubAppConfigFromEnv,
} from "@nearform/mac-github";
import { createChatAgent as createPackageChatAgent } from "@nearform/mac-agent-workflows";
import { defaultModel } from "../config.js";
import { createChatMemory } from "../memory.js";

/**
 * Chat agent — the in-process conversational surface. The reusable factory lives
 * in `@nearform/mac-agent-workflows`; this app shim supplies the app deps
 * (model + memory) and decides whether to attach read-only GitHub tools.
 *
 * GitHub tools are attached only when the GitHub App env is configured AND the
 * PEM is readable; an optional secret must never crash boot — the agent still
 * answers, just without repo access (keeps `mastra dev` usable before secrets
 * are wired).
 */
export function createChatAgent(): Agent {
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

  return createPackageChatAgent({
    model: defaultModel(),
    memory: createChatMemory(),
    tools,
  });
}
