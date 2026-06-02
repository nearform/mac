import { registerApiRoute } from "@mastra/core/server";

/**
 * Programmatic trigger endpoints for the CLI (packages/mac-cli) — the Mastra re-home
 * of the original's `/api/build` + `/api/run` routes (which were mounted on the
 * webhook's Hono app). Thin: they start a workflow run and return its runId.
 *
 * NOTE: paths are `/cli/*`, NOT `/api/*` — Mastra reserves the `/api` prefix for
 * its built-in routes and rejects custom routes under it at server startup.
 *
 * Only the workflows ported so far are runnable: `build` (via /api/build or
 * skill `github-orchestrator`) and `pr-review`. Other skills return 501 until
 * M6 wires their workflows.
 */

// Health probe. The `@mastra/hono` MastraServer adapter we embed in server.ts
// does NOT mount a built-in `GET /health` (unlike the `mastra dev` server), so
// we own it here. The CLI thin-client (packages/mac-cli) pings this before
// POSTing a trigger, and it doubles as a deploy/liveness check.
export const healthApiRoute = registerApiRoute("/health", {
  method: "GET",
  requiresAuth: false,
  handler: async (c) => c.json({ success: true, service: "mac" }),
});

async function startRun(workflow: any, inputData: Record<string, unknown>): Promise<string> {
  const run = await workflow.createRun();
  void Promise.resolve(run.start({ inputData })).catch((err: unknown) => {
    console.error(`[cli-api] run ${run.runId} failed:`, err);
  });
  return run.runId as string;
}

export const buildApiRoute = registerApiRoute("/cli/build", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const owner = typeof b.owner === "string" ? b.owner : "";
    const repo = typeof b.repo === "string" ? b.repo : "";
    const issueNumber = typeof b.issueNumber === "number" ? b.issueNumber : NaN;
    if (!owner || !repo || !Number.isFinite(issueNumber)) {
      return c.json({ error: "owner, repo, issueNumber required" }, 400);
    }
    const workflow = c.get("mastra").getWorkflow("build") as any;
    const runId = await startRun(workflow, {
      owner,
      repo,
      issueNumber,
      issueTitle: typeof b.issueTitle === "string" ? b.issueTitle : "",
      issueBody: typeof b.issueBody === "string" ? b.issueBody : "",
      baseBranch: typeof b.baseBranch === "string" ? b.baseBranch : "main",
    });
    return c.json({ accepted: true, workflow: "build", runId }, 202);
  },
});

export const runApiRoute = registerApiRoute("/cli/run", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const skill = typeof b.skill === "string" ? b.skill : "";
    const ctx = (b.context ?? {}) as Record<string, unknown>;
    const mastra = c.get("mastra");

    if (skill === "pr-review") {
      const repoStr = typeof ctx.repo === "string" ? ctx.repo : "";
      const [owner, repo] = repoStr.split("/");
      const number =
        typeof ctx.prNumber === "number" ? ctx.prNumber :
        typeof ctx.issueNumber === "number" ? ctx.issueNumber : NaN;
      if (!owner || !repo || !Number.isFinite(number)) {
        return c.json({ error: "context.repo (owner/repo) + prNumber/issueNumber required" }, 400);
      }
      const runId = await startRun(mastra.getWorkflow("pr-review") as any, { owner, repo, number });
      return c.json({ accepted: true, workflow: "pr-review", runId }, 202);
    }

    if (skill === "github-orchestrator") {
      const repoStr = typeof ctx.repo === "string" ? ctx.repo : "";
      const [owner, repo] = repoStr.split("/");
      const issueNumber = typeof ctx.issueNumber === "number" ? ctx.issueNumber : NaN;
      if (!owner || !repo || !Number.isFinite(issueNumber)) {
        return c.json({ error: "context.repo (owner/repo) + issueNumber required" }, 400);
      }
      const runId = await startRun(mastra.getWorkflow("build") as any, {
        owner, repo, issueNumber, issueTitle: "", issueBody: "", baseBranch: "main",
      });
      return c.json({ accepted: true, workflow: "build", runId }, 202);
    }

    return c.json({ error: `skill "${skill}" not wired up in the Mastra port yet (M6)` }, 501);
  },
});
