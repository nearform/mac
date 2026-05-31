import { RequestContext } from "@mastra/core/request-context";
import { createGithubReadTools, createTokenOctokit } from "@lastlight/github";
import { createCodeWorkspace } from "../workspace.js";

/**
 * Per-run plumbing for the REGISTERED build agents.
 *
 * The build agents (guardrails/architect/executor/fix/reviewer) are registered
 * on the Mastra instance so they get `__registerMastra` → the observability
 * exporter, so their LLM messages + tool calls (incl. each sandbox
 * `execute_command`) show up as spans in Studio. But their sandbox checkout and
 * GitHub token are PER-RUN, so those can't be baked in at construction. Mastra
 * supports this: `workspace` and `tools` are `DynamicArgument`s — functions of
 * `requestContext` — resolved at each `generate()` call. The step builds a fresh
 * RequestContext (so the short-lived token is NOT written into the persisted
 * workflow snapshot) and passes it to `generate({ requestContext })`.
 */

/** RequestContext keys the dynamic resolvers below read. */
export const RC_TASK_ID = "taskId";
export const RC_TOKEN = "token";

/** Build a per-call RequestContext carrying the run's taskId (+ optional token). */
export function buildAgentContext(taskId: string, token?: string): RequestContext {
  const rc = new RequestContext();
  rc.set(RC_TASK_ID, taskId);
  if (token) rc.set(RC_TOKEN, token);
  return rc;
}

/** Dynamic `workspace`: the per-run sandbox checkout (undefined if no taskId). */
export function workspaceFromContext({ requestContext }: { requestContext: RequestContext }) {
  const taskId = requestContext.get(RC_TASK_ID);
  return typeof taskId === "string" && taskId ? createCodeWorkspace(taskId) : undefined;
}

/** Dynamic `tools`: GitHub read tools authed with the per-run token (empty if none). */
export function readToolsFromContext({ requestContext }: { requestContext: RequestContext }) {
  const token = requestContext.get(RC_TOKEN);
  return typeof token === "string" && token
    ? createGithubReadTools(createTokenOctokit(token))
    : {};
}
