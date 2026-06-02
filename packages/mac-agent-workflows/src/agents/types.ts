import type { Agent } from "@mastra/core/agent";
import type { WorkspaceFactory } from "@nearform/mac/core";
// Type-only edge to the GitHub platform package's dependency-light contract.
// This carries NO runtime dependency (no Octokit) — it is the sanctioned
// type-only import the refactor allows; never a runtime `import` of the root.
import type { GithubTools } from "@nearform/mac-github/capabilities";
import type { PromptResolver } from "../loaders/prompts.js";

/** The read-tools bundle, derived from the GitHub capability's factory return. */
type GithubReadTools = ReturnType<GithubTools["createReadTools"]>;

/**
 * Shared dependency object for the coding agent factories
 * (reviewer / build-reviewer / architect / executor / fix / guardrails).
 *
 * Every value the factory needs is injected — there is no `process.env`, app
 * config, workspace, or runtime platform import inside the package. The app
 * assembles this from its own modules (see the app `agents/deps.ts` shim).
 */
export interface CodingAgentDeps {
  /** Model id, e.g. "openai/gpt-4o". */
  model: string;
  /** Tool-call step budget for the agent's `defaultOptions.maxSteps`. Default 40. */
  maxSteps?: number;
  /** Creates the per-run sandbox checkout, keyed by taskId. */
  workspaceFactory: WorkspaceFactory;
  /** Builds GitHub read tools from a per-run scoped token. */
  createReadTools: (args: { token: string }) => GithubReadTools;
  /** Layered prompt resolver. Defaults to `defaultPromptResolver`. */
  promptResolver?: PromptResolver;
}

/**
 * The Mastra memory option type, extracted from the `Agent` constructor's
 * config so we do not add an `@mastra/memory` dependency to this package.
 */
type AgentMemory = NonNullable<ConstructorParameters<typeof Agent>[0]["memory"]>;

/** The Agent constructor's `tools` option type (so chat tools stay assignable). */
type AgentTools = NonNullable<ConstructorParameters<typeof Agent>[0]["tools"]>;

/**
 * Dependencies for the chat agent. Chat is the conversational surface: it gets
 * memory and optional read-only tools, but no per-run workspace.
 */
export interface ChatAgentDeps {
  model: string;
  /** A Mastra memory instance (typed via the Agent constructor option). */
  memory?: AgentMemory;
  /** Pre-built read-only tools (empty record if GitHub is not configured). */
  tools?: AgentTools;
}
