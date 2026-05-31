/**
 * Minimal runtime config for the spike. Replaces lastlight's layered YAML
 * overlay (config/default.yaml + instance overlay + env) with plain env reads.
 * See ../../../MIGRATION.md — config overlay layering is intentionally dropped.
 */

import { createHmac } from "crypto";

/** Absolute SQLite URL, cwd-independent (see index.ts note on libsql error 14). */
export function dbUrl(): string {
  return (
    process.env.LASTLIGHT_DB_URL ??
    `file:${process.env.LASTLIGHT_STATE_DIR ?? process.cwd()}/lastlight.db`
  );
}

/**
 * Absolute path to the DuckDB file backing the OBSERVABILITY domain (AI traces +
 * metrics). Per Mastra's docs, observability is analytical (OLAP) data, so it's
 * routed to DuckDB via a composite store while the rest stays on LibSQL (see
 * index.ts). Absolute + cwd-independent like dbUrl(). `:memory:` for ephemeral.
 */
export function duckDbPath(): string {
  return (
    process.env.LASTLIGHT_OBS_DB_PATH ??
    `${process.env.LASTLIGHT_STATE_DIR ?? process.cwd()}/observability.duckdb`
  );
}

/**
 * Default model router string. Spike uses OpenAI (the key present in the copied
 * .env); override with LASTLIGHT_MODEL. lastlight's configured
 * anthropic/claude-sonnet-4-6 needs ANTHROPIC_API_KEY to be added first.
 */
export function defaultModel(): string {
  return process.env.LASTLIGHT_MODEL ?? "openai/gpt-4o";
}

/**
 * Tool-call step budget for the build agents. Mastra's default `maxSteps` is 5,
 * which is far too low for an agent that has to read docs, run `npm install`,
 * then run tests/lint/typecheck before summarising — it gets cut off mid
 * tool-loop and returns EMPTY final text (the bug behind guardrails' missing
 * `GUARDRAILS:` marker). We set a generous default on each agent's
 * `defaultOptions` so the ceiling applies to BOTH our workflow `generate()`
 * calls and interactive Studio playground runs. Override via env for tuning.
 */
export function agentMaxSteps(): number {
  return Number(process.env.LASTLIGHT_AGENT_MAX_STEPS ?? 40);
}

// ── M5 connectors (webhook + approval link) ──────────────────────────────────

/** GitHub webhook HMAC secret — must match the GitHub App's configured secret. */
export function webhookSecret(): string {
  return process.env.WEBHOOK_SECRET ?? "";
}

/**
 * Bot login used for self-event filtering. The webhook also treats any
 * `*[bot]` sender as a bot, so this only needs to match the bare app name.
 */
export function botLogin(): string {
  return process.env.GITHUB_APP_BOT_NAME ?? "lastlight";
}

/**
 * Public base URL the bot is reachable at — used to build the ✅/❌ approval
 * links in the issue status comment. For local testing point it at an ngrok
 * tunnel (the links are clicked from GitHub in the user's browser). Defaults to
 * the local Mastra server, where the apiRoutes are hosted.
 */
export function publicBaseUrl(): string {
  const fallback = `http://localhost:${process.env.PORT ?? 4111}`;
  return (process.env.LASTLIGHT_PUBLIC_URL ?? fallback).replace(/\/+$/, "");
}

/**
 * Secret used to sign approval links. Reuses ADMIN_SECRET / WEBHOOK_SECRET when
 * present so we don't add another required env var. Stateless: the token is an
 * HMAC of the runId, so the /approve endpoint can verify a click without a DB
 * row. ("assume the user is logged in" — this is the unguessable-link floor;
 * real session auth is deferred.)
 */
function approvalSecret(): string {
  return (
    process.env.LASTLIGHT_APPROVAL_SECRET ??
    process.env.ADMIN_SECRET ??
    process.env.WEBHOOK_SECRET ??
    "lastlight-dev-approval-secret"
  );
}

/** Derive the unguessable approval token for a workflow run. */
export function approvalToken(runId: string): string {
  return createHmac("sha256", approvalSecret()).update(runId).digest("hex").slice(0, 32);
}

/** Build a signed approval/reject link for the issue status comment. */
export function approvalLink(runId: string, decision: "approve" | "reject"): string {
  const token = approvalToken(runId);
  return `${publicBaseUrl()}/approve?runId=${encodeURIComponent(runId)}&decision=${decision}&token=${token}`;
}

// ── M5 Stage B: Slack (Socket Mode) ──────────────────────────────────────────

/** Resolved Slack connector config, or null when not configured. */
export interface SlackConfig {
  /** Bot User OAuth Token (xoxb-…) */
  botToken: string;
  /** App-Level Token for Socket Mode (xapp-…) */
  appToken: string;
  /** User IDs allowed to interact with the bot (empty = allow everyone). */
  allowedUsers: string[];
  /** Channel ID for cron/report delivery (optional). */
  homeChannel?: string;
}

/**
 * Slack config from env, or null if the two required tokens aren't both set.
 * Socket Mode needs BOTH the bot token (xoxb) and the app-level token (xapp);
 * a null result is the signal to skip starting the connector at boot — exactly
 * how lastlight gated the Slack connector + chat path.
 */
export function slackConfig(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) return null;
  return {
    botToken,
    appToken,
    allowedUsers: (process.env.SLACK_ALLOWED_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    homeChannel: process.env.SLACK_HOME_CHANNEL || undefined,
  };
}
