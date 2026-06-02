import type { Agent } from "@mastra/core/agent";
import {
  type MacExtension,
  type MacExtensionContext,
  type MacExtensionResult,
  type WorkspaceFactory,
} from "@nearform/mac/core";
import { githubCapabilities } from "@nearform/mac-github/capabilities";
import { createChatAgent } from "./chat.js";
import { createReviewerAgent, createBuildReviewerAgent } from "./reviewer.js";
import { createArchitectAgent } from "./architect.js";
import { createExecutorAgent, createFixAgent } from "./executor.js";
import { createGuardrailsAgent } from "./guardrails.js";
import type { CodingAgentDeps } from "./types.js";

export {
  createChatAgent,
  createReviewerAgent,
  createBuildReviewerAgent,
  createArchitectAgent,
  createExecutorAgent,
  createFixAgent,
  createGuardrailsAgent,
};
export type { CodingAgentDeps, ChatAgentDeps } from "./types.js";

/** Selector for the built-in agents (see the refactor doc, `AgentsSelector`). */
export interface AgentsSelector {
  use: string[];
  /** Optional per-agent model override, keyed by agent id. Falls back to host model. */
  models?: Record<string, string>;
  /**
   * Tool-call step budget for the coding agents' `defaultOptions.maxSteps`.
   * Falls back to the factory default (40) when unset. The app threads its
   * configured value (e.g. `MAC_AGENT_MAX_STEPS`) through here so the
   * override applies on the host path, not only the bare-factory path.
   */
  maxSteps?: number;
}

/** The registered-instance keys the selector understands, and their factories. */
const CODING_BUILDERS: Record<string, (deps: CodingAgentDeps) => Agent> = {
  reviewer: createReviewerAgent,
  "build-reviewer": createBuildReviewerAgent,
  architect: createArchitectAgent,
  executor: createExecutorAgent,
  fix: createFixAgent,
  guardrails: createGuardrailsAgent,
};

/**
 * The `agents()` extension. Constructs each selected built-in agent ONCE using
 * configured capabilities (the GitHub read-tools factory + the host workspace
 * factory) and RETURNS the instances in `MacExtensionResult.agents`. The HOST
 * owns the single live agent registry: it merges these into the one `agentMap`
 * it published under `agentRegistryCapability`/`agentCapabilities` before any
 * init ran, so workflows consume registered (traced) instances rather than
 * constructing duplicates. The selector does NOT call `provide(...)` itself.
 *
 * Phase 6 wires the host that consumes this.
 */
export function agents(selector: AgentsSelector): MacExtension {
  const { use, models, maxSteps } = selector;
  return {
    name: "agents",
    // GitHub is OPTIONAL: when a `github()` platform is installed the read-tools
    // factory is wired in; without it the coding agents still construct (read
    // tools disabled, mirroring chat). `optional` orders this after `github()`
    // when present but does not fail preflight when it is absent — this is what
    // lets a no-secrets dev boot run through the single createMacApp path.
    optional: [githubCapabilities],
    init(context: MacExtensionContext): MacExtensionResult {
      const github = context.capabilities.optional(githubCapabilities);
      const createReadTools: CodingAgentDeps["createReadTools"] =
        github?.tools?.createReadTools ??
        // No GitHub configured → no-op read tools. The coding factories never
        // invoke this at construction (tools resolve per-run from
        // requestContext), so an empty record is safe; the cast satisfies the
        // strict return type.
        (() => ({}) as ReturnType<CodingAgentDeps["createReadTools"]>);
      const workspaceFactory = context.workspaceFactory as WorkspaceFactory;
      const modelFor = (id: string): string => models?.[id] ?? context.model;

      const codingDeps = (id: string): CodingAgentDeps => ({
        model: modelFor(id),
        maxSteps,
        workspaceFactory,
        createReadTools,
      });

      const record: Record<string, Agent> = {};
      for (const id of use) {
        if (id === "chat") {
          record.chat = createChatAgent({ model: modelFor("chat") });
          continue;
        }
        const builder = CODING_BUILDERS[id];
        if (!builder) {
          throw new Error(
            `agents({ use }) — unknown built-in agent "${id}" (available: chat, ${Object.keys(CODING_BUILDERS).join(", ")})`,
          );
        }
        record[id] = builder(codingDeps(id));
      }

      return {
        agents: record,
        // The CHAT intent is the catch-all/default: the host routes here when the
        // classifier matches nothing actionable, or when a matched intent's repo/
        // issue requirements can't be satisfied. Other intents (BUILD/REVIEW/...)
        // are contributed by the workflows() definitions. No deterministic route —
        // a no-eventTypes route would swallow every event in the dispatch loop.
        classifierIntents: [
          {
            id: "CHAT",
            description:
              "General conversation, questions, thanks, or anything with no specific build/review intent. The conversational fallback.",
            examples: ["how does the build flow work?", "thanks!", "what can you do?"],
            isDefault: true,
            target: { type: "agent", id: "chat" },
          },
        ],
      };
    },
  };
}
