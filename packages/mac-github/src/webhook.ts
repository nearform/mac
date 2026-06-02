import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { registerApiRoute } from "@mastra/core/server";
import type { ApiRoute } from "@mastra/core/server";
import type { EventEnvelope, EventType, DispatchFn } from "@nearform/mac/core";

/**
 * GitHub webhook signature verification + payload → EventEnvelope normalization,
 * plus `createGithubWebhookRoute(...)` — the single GitHub webhook ingestion path.
 *
 * Ported from the original `src/connectors/github-webhook.ts` (the `verifySignature`
 * + `normalize` logic, verbatim). The only change for the Mastra port: instead
 * of living inside a self-hosted Hono `Connector`/EventEmitter, these are plain
 * functions the Mastra `registerApiRoute` handler calls. The bot-filter +
 * ignored-action rules are unchanged.
 */

/**
 * GitHub webhook actions we skip — noisy and never need agent work.
 *
 * NOTE: `synchronize` is intentionally NOT in this set. It fires on every new
 * commit pushed to a PR's branch and is the canonical "needs a fresh review"
 * trigger.
 */
export const IGNORED_ACTIONS = new Set([
  "deleted",
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "closed",
  "milestoned",
  "demilestoned",
  "locked",
  "unlocked",
  "transferred",
  "pinned",
  "unpinned",
]);

/** HMAC-SHA256 verification of the `x-hub-signature-256` header. */
export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Should this event be dropped as a bot self-event?
 *
 * Exception: `pull_request` opened/synchronize/reopened from a bot sender must
 * still flow through — a bot opening its own PR or pushing a fix commit is the
 * canonical "needs a fresh review" signal. Comment/issue paths keep the strict
 * filter so the bot never replies to its own comments.
 */
export function isFilteredBotEvent(
  payload: any,
  eventType: string,
  action: string | undefined,
  botLogin: string,
): boolean {
  const senderLogin = payload.sender?.login || "";
  const senderType = payload.sender?.type || "";
  const isBotSender =
    senderType === "Bot" ||
    senderLogin === botLogin ||
    senderLogin.endsWith("[bot]");
  const isPrAttention =
    eventType === "pull_request" &&
    (action === "opened" || action === "synchronize" || action === "reopened");
  return isBotSender && !isPrAttention;
}

/**
 * Normalize a GitHub webhook payload into an EventEnvelope.
 * Returns null for unmapped event/action combinations. The `reply` callback is
 * provided by the caller (posts a comment on the issue/PR via a minted token).
 */
export function normalizeGithubEvent(
  githubEvent: string,
  action: string | undefined,
  payload: any,
  deliveryId: string,
  reply: (owner: string, repo: string, issueNumber: number, body: string) => Promise<void>,
): EventEnvelope | null {
  const repoFullName = payload.repository?.full_name;
  const sender = payload.sender?.login || "unknown";

  let type: EventType | null = null;
  let issueNumber: number | undefined;
  let prNumber: number | undefined;
  let body = "";
  let title = "";
  let labels: string[] = [];

  switch (githubEvent) {
    case "issues":
      issueNumber = payload.issue?.number;
      body = payload.issue?.body || "";
      title = payload.issue?.title || "";
      labels = (payload.issue?.labels || []).map((l: any) => l.name);
      if (action === "opened") type = "issue.opened";
      else if (action === "reopened") type = "issue.reopened";
      break;

    case "pull_request":
      prNumber = payload.pull_request?.number;
      issueNumber = prNumber; // PRs are issues too
      body = payload.pull_request?.body || "";
      title = payload.pull_request?.title || "";
      labels = (payload.pull_request?.labels || []).map((l: any) => l.name);
      if (action === "opened") type = "pr.opened";
      else if (action === "synchronize") type = "pr.synchronize";
      else if (action === "reopened") type = "pr.reopened";
      break;

    case "issue_comment":
      issueNumber = payload.issue?.number;
      body = payload.comment?.body || "";
      title = payload.issue?.title || "";
      // Carry the parent issue's labels through — the router keys on
      // `security-scan` to divert comments on summary issues.
      labels = (payload.issue?.labels || []).map((l: any) => l.name);
      if (action === "created") type = "comment.created";
      if (payload.issue?.pull_request) {
        prNumber = issueNumber;
      }
      break;

    case "pull_request_review":
      prNumber = payload.pull_request?.number;
      issueNumber = prNumber;
      body = payload.review?.body || "";
      title = payload.pull_request?.title || "";
      if (action === "submitted") type = "pr_review.submitted";
      break;

    case "pull_request_review_comment":
      prNumber = payload.pull_request?.number;
      issueNumber = prNumber;
      body = payload.comment?.body || "";
      title = payload.pull_request?.title || "";
      if (action === "created") type = "pr_review_comment.created";
      break;
  }

  if (!type) return null;

  const [owner, repo] = (repoFullName || "/").split("/");

  const replyFn = async (msg: string) => {
    if (repoFullName && issueNumber) {
      await reply(owner, repo, issueNumber, msg);
    }
  };

  return {
    id: deliveryId,
    source: "github",
    type,
    repo: repoFullName,
    issueNumber,
    prNumber,
    sender,
    senderIsBot: false, // already filtered bots above
    body,
    title,
    labels,
    authorAssociation:
      payload.comment?.author_association ||
      payload.issue?.author_association ||
      payload.pull_request?.author_association,
    raw: payload,
    reply: replyFn,
    timestamp: new Date(),
  };
}

/**
 * Arguments for {@link createGithubWebhookRoute}. The caller injects the
 * platform-specific pieces (secret, bot login, managed-repo check, reply
 * publisher) and the per-request dispatcher factory. This keeps the package as
 * the single owner of the verify/filter/normalize flow while the host supplies
 * its Mastra-bound dispatcher.
 */
export interface GithubWebhookRouteArgs {
  /** Route path. Defaults to "/webhooks/github". */
  path?: string;
  /** Webhook HMAC secret, as a value or a getter resolved per request. */
  webhookSecret: string | (() => string);
  /** Bot login for self-event filtering, as a value or a getter. */
  botLogin: string | (() => string);
  /** Is this repo one the app is allowed to operate on? */
  isManagedRepo: (repo: string | undefined | null) => boolean;
  /** Post a reply comment on the issue/PR. */
  replyOnIssue: (owner: string, repo: string, issueNumber: number, body: string) => Promise<void>;
  /** Build the dispatcher for this request — the app closes over its Mastra instance here. */
  createDispatch: (c: any) => DispatchFn;
}

function resolve(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

/**
 * GitHub webhook ingestion as a Mastra apiRoute.
 *
 * Flow: verify HMAC → drop ignored actions / bot self-events / unmanaged repos
 * → normalize to EventEnvelope → dispatch (background) → 202.
 */
export function createGithubWebhookRoute(args: GithubWebhookRouteArgs): ApiRoute {
  const path = args.path ?? "/webhooks/github";
  return registerApiRoute(path, {
    method: "POST",
    requiresAuth: false,
    handler: async (c) => {
      const body = await c.req.text();

      const signature = c.req.header("x-hub-signature-256");
      if (!signature || !verifySignature(body, signature, resolve(args.webhookSecret))) {
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
      if (isFilteredBotEvent(payload, eventType, action, resolve(args.botLogin))) {
        return c.json({ filtered: true, reason: "bot sender" }, 200);
      }

      const repoFullName = payload.repository?.full_name;
      if (!args.isManagedRepo(repoFullName)) {
        console.log(`[github] filtered webhook for unmanaged repo: ${repoFullName}`);
        return c.json({ filtered: true, reason: `repo not managed: ${repoFullName}` }, 200);
      }

      const envelope = normalizeGithubEvent(eventType, action, payload, deliveryId, args.replyOnIssue);
      if (!envelope) {
        return c.json({ filtered: true, reason: "unmapped event" }, 200);
      }

      // Route + dispatch in the background so the webhook responds fast (the
      // classifier/screener LLM calls + workflow start take seconds).
      const dispatch = args.createDispatch(c);
      void dispatch(envelope).catch((err: unknown) => {
        console.error(`[github] dispatch failed for ${deliveryId}:`, err);
      });

      return c.json({ accepted: true, id: deliveryId }, 202);
    },
  });
}
