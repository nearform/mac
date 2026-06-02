import { RequestContext } from "@mastra/core/request-context";

/**
 * Per-run plumbing for the REGISTERED coding agents (pure — no app/env/platform
 * imports).
 *
 * The coding agents (guardrails/architect/executor/fix/reviewer) are registered
 * on the Mastra instance so they get the observability exporter wired in, so
 * their LLM messages + tool calls (incl. each sandbox `execute_command`) show up
 * as spans in Studio. But their sandbox checkout and GitHub token are PER-RUN,
 * so those can't be baked in at construction. Mastra supports this: `workspace`
 * and `tools` are `DynamicArgument`s — functions of `requestContext` — resolved
 * at each `generate()` call. The workflow step builds a fresh RequestContext (so
 * the short-lived token is NOT written into the persisted workflow snapshot) and
 * passes it to `generate({ requestContext })`.
 *
 * The agent factories close over their injected `workspaceFactory` /
 * `createReadTools` deps and read these keys off the request context.
 */

/** RequestContext keys the dynamic resolvers in the factories read. */
export const RC_TASK_ID = "taskId";
export const RC_TOKEN = "token";

/** Build a per-call RequestContext carrying the run's taskId (+ optional token). */
export function buildAgentContext(taskId: string, token?: string): RequestContext {
  const rc = new RequestContext();
  rc.set(RC_TASK_ID, taskId);
  if (token) rc.set(RC_TOKEN, token);
  return rc;
}
