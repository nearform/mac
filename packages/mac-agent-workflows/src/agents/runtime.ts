import { RequestContext } from "@mastra/core/request-context";
import type { Workspace } from "@mastra/core/workspace";
import type { WorkspaceFactory } from "@nearform/mac/core";

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
/**
 * Skill folder names this step's agent should load. The workflow step decides
 * the list (per-step policy); the agent's `workspace` resolver reads it here and
 * forwards it to `workspaceFactory.create(taskId, { skills })`.
 */
export const RC_SKILLS = "skills";

/**
 * Build a per-call RequestContext carrying the run's taskId (+ optional token,
 * + optional per-step skill allowlist). The skills list is the workflow step's
 * choice of which skills its agent loads (see workflows/build.ts, pr-review.ts).
 */
export function buildAgentContext(
  taskId: string,
  token?: string,
  skills?: readonly string[],
): RequestContext {
  const rc = new RequestContext();
  rc.set(RC_TASK_ID, taskId);
  if (token) rc.set(RC_TOKEN, token);
  if (skills && skills.length > 0) rc.set(RC_SKILLS, [...skills]);
  return rc;
}

/**
 * Resolve the per-run workspace for a registered coding agent from the request
 * context: the taskId keys the checkout, and the optional RC_SKILLS list scopes
 * the workspace to just this step's skills. Returns undefined when no taskId is
 * present (the agent then runs without a workspace). Shared by every agent's
 * `workspace` resolver so skill scoping is wired in exactly one place.
 */
export function resolveWorkspace(
  factory: WorkspaceFactory,
  requestContext: RequestContext,
): Workspace | undefined {
  const taskId = requestContext.get(RC_TASK_ID);
  if (typeof taskId !== "string" || !taskId) return undefined;
  const skills = requestContext.get(RC_SKILLS);
  const scoped = Array.isArray(skills) && skills.length > 0 ? (skills as string[]) : undefined;
  return factory.create(taskId, scoped ? { skills: scoped } : undefined);
}
