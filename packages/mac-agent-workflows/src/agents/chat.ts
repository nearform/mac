import { Agent } from "@mastra/core/agent";
import { defaultPromptResolver } from "../loaders/prompts.js";
import { persona } from "./persona.js";
import type { ChatAgentDeps } from "./types.js";

/**
 * Authoritative model-identity preamble built from the configured model string
 * (e.g. `lmstudio/qwen/qwen3-30b-a3b-2507` → provider `lmstudio`, model
 * `qwen/qwen3-30b-a3b-2507`). Small local models have unreliable self-knowledge
 * and latch onto incidental tokens in the persona (which references `CLAUDE.md`
 * for repo conventions), so an un-grounded "what model are you?" gets answered
 * with a hallucinated vendor. Stating the real model grounds the answer in fact.
 */
function modelIdentity(model: string): string {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const name = slash > 0 ? model.slice(slash + 1) : model;
  const via = provider ? ` (served via ${provider})` : "";
  return [
    "# Your model identity",
    "",
    `You are powered by the \`${name}\` language model${via}. When the user asks`,
    "which model, LLM, or AI you are, answer with this.",
    "",
    "---",
    "",
  ].join("\n");
}

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
    instructions: modelIdentity(deps.model) + persona() + resolver.resolve("chat"),
    model: deps.model,
    tools: deps.tools ?? {},
    memory: deps.memory,
  });
}
