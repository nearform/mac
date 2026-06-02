import { Agent } from "@mastra/core/agent";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import type { ChatAgentDeps } from "./types.js";

/**
 * Chat agent — the in-process conversational surface. Gets conversation memory
 * and optional read-only GitHub tools.
 *
 * Unlike the coding agents, chat takes its memory + tools as pre-built injected
 * deps rather than per-run request-context resolvers: the conversation memory
 * and the installation-scoped tools are stable for the agent's lifetime. The app
 * decides whether GitHub tools are present (the package never reads env).
 */
export function createChatAgent(
  deps: ChatAgentDeps & { promptResolver?: typeof defaultPromptResolver },
): Agent {
  const resolver = deps.promptResolver ?? defaultPromptResolver;
  return new Agent({
    id: "chat",
    name: "chat",
    instructions: persona() + resolver.resolve("chat"),
    model: deps.model,
    tools: deps.tools ?? {},
    memory: deps.memory,
  });
}
