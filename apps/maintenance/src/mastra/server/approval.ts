import { registerApiRoute } from "@mastra/core/server";
import { approvalToken } from "../config.js";

/**
 * Approval-via-link endpoint. The build workflow's `post_architect` gate renders
 * ✅ Approve / ❌ Reject links into the issue status comment (see workflows/
 * build.ts → renderStatusComment). Each link carries the workflow `runId` and an
 * HMAC `token`. Clicking one lands here, which resumes the suspended run with the
 * decision — no `@last-light approve` comment + fuzzy run-lookup needed, because
 * the link already names the exact run.
 *
 * "assume the user is logged in": there is no session check here yet — the
 * unguessable token is the floor. Real auth (a logged-in dashboard session) is
 * deferred.
 */

function page(title: string, body: string, accent: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#0d1117; color:#e6edf3;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { text-align:center; padding:2.5rem 3rem; border:1px solid #30363d; border-radius:12px;
          background:#161b22; max-width:30rem; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; color:${accent}; }
  p { color:#9da7b3; line-height:1.5; margin:.25rem 0; }
</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export const approvalRoute = registerApiRoute("/approve", {
  method: "GET",
  requiresAuth: false,
  handler: async (c) => {
    const runId = c.req.query("runId") ?? "";
    const token = c.req.query("token") ?? "";
    const decisionRaw = c.req.query("decision") ?? "";
    const reason = c.req.query("reason") ?? undefined;

    const decision = decisionRaw === "approve" || decisionRaw === "reject" ? decisionRaw : null;
    if (!runId || !decision) {
      return page("Invalid link", "<p>Missing or malformed approval parameters.</p>", "#ef4444");
    }
    if (token !== approvalToken(runId)) {
      return page("Invalid token", "<p>This approval link is not valid.</p>", "#ef4444");
    }

    const mastra = c.get("mastra");
    const workflow = mastra.getWorkflow("build") as any;
    if (!workflow) {
      return page("Unavailable", "<p>The build workflow is not registered.</p>", "#ef4444");
    }

    // If it's not currently suspended, it was already resolved (double-click) or
    // never existed — report rather than erroring.
    try {
      const state = await workflow.getWorkflowRunById(runId);
      if (state && state.status && state.status !== "suspended") {
        return page(
          "Already resolved",
          `<p>This build (run <code>${runId.slice(0, 8)}</code>) is already <b>${state.status}</b> — no action taken.</p>`,
          "#9da7b3",
        );
      }
    } catch (e) {
      // getWorkflowRunById is best-effort guidance; fall through to resume.
      console.warn(`[approve] status check failed: ${(e as Error).message}`);
    }

    try {
      const run = await workflow.createRun({ runId });
      void Promise.resolve(
        run.resume({
          step: "post_architect",
          resumeData: { decision, reason },
        }),
      ).catch((err: unknown) => {
        console.error(`[approve] resume of run ${runId} failed:`, err);
      });
    } catch (e) {
      console.error(`[approve] could not resume run ${runId}:`, e);
      return page("Error", "<p>Could not resume the build run. Check the server logs.</p>", "#ef4444");
    }

    if (decision === "approve") {
      return page("✅ Approved", "<p>The build is continuing — implementation has started.</p><p>You can close this tab.</p>", "#22c55e");
    }
    return page("❌ Rejected", "<p>The build has been aborted. The plan was not implemented.</p><p>You can close this tab.</p>", "#ef4444");
  },
});
