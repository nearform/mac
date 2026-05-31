import { registerApiRoute } from "@mastra/core/server";
import { randomUUID } from "crypto";
import {
  githubAppConfigFromEnv,
  mintTokenForProfile,
  createTokenOctokit,
  addIssueComment,
} from "@lastlight/github";
import {
  IGNORED_ACTIONS,
  verifySignature,
  isFilteredBotEvent,
  normalizeGithubEvent,
} from "../engine/github-normalize.js";
import { isManagedRepo } from "../managed-repos.js";
import { webhookSecret, botLogin } from "../config.js";
import { createDispatcher } from "../engine/dispatch.js";

/**
 * GitHub webhook ingestion as a Mastra apiRoute.
 *
 * This is the Mastra-native re-home of lastlight's `GitHubWebhookConnector`
 * (which self-hosted its own Hono server). The proven verify/filter/normalize
 * logic is ported verbatim (engine/github-normalize.ts); only the transport
 * changed — Mastra hosts this route on its server, which also fixes the
 * "start a socket during `mastra build`" problem a self-hosted connector had.
 *
 * Flow: verify HMAC → drop ignored actions / bot self-events / unmanaged repos
 * → normalize to EventEnvelope → routeEvent + dispatch (background) → 202.
 */

/** Post a reply comment on the issue/PR via a minted issues-write token. */
async function replyOnIssue(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
  const cfg = githubAppConfigFromEnv();
  if (!cfg) {
    console.warn("[github] reply skipped — GitHub App not configured");
    return;
  }
  const { token } = await mintTokenForProfile(cfg, "issues-write");
  const octokit = createTokenOctokit(token);
  await addIssueComment(octokit, { owner, repo, number: issueNumber, body });
}

export const githubWebhookRoute = registerApiRoute("/webhooks/github", {
  method: "POST",
  requiresAuth: false,
  handler: async (c) => {
    const body = await c.req.text();

    const signature = c.req.header("x-hub-signature-256");
    if (!signature || !verifySignature(body, signature, webhookSecret())) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const eventType = c.req.header("x-github-event");
    const deliveryId = c.req.header("x-github-delivery") || randomUUID();
    if (!eventType) {
      return c.json({ filtered: true, reason: "missing event type" }, 200);
    }

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const action = payload.action as string | undefined;

    if (action && IGNORED_ACTIONS.has(action)) {
      return c.json({ filtered: true, reason: `action=${action}` }, 200);
    }
    if (isFilteredBotEvent(payload, eventType, action, botLogin())) {
      return c.json({ filtered: true, reason: "bot sender" }, 200);
    }

    const repoFullName = payload.repository?.full_name;
    if (!isManagedRepo(repoFullName)) {
      console.log(`[github] filtered webhook for unmanaged repo: ${repoFullName}`);
      return c.json({ filtered: true, reason: `repo not managed: ${repoFullName}` }, 200);
    }

    const envelope = normalizeGithubEvent(eventType, action, payload, deliveryId, replyOnIssue);
    if (!envelope) {
      return c.json({ filtered: true, reason: "unmapped event" }, 200);
    }

    // Route + dispatch in the background so the webhook responds fast (the
    // classifier/screener LLM calls + workflow start take seconds).
    const dispatch = createDispatcher(c.get("mastra"));
    void dispatch(envelope).catch((err: unknown) => {
      console.error(`[github] dispatch failed for ${deliveryId}:`, err);
    });

    return c.json({ accepted: true, id: deliveryId }, 202);
  },
});
