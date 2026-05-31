import { WebClient } from "@slack/web-api";
import { slackConfig } from "../../config.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

/**
 * Outbound Slack notifier — the seam workflows use to feed progress/results back
 * to the Slack thread that initiated them (mirroring how `build.ts` keeps a live
 * GitHub issue comment). Detached workflow runs can't hold the connector
 * instance, so the client is a module-level singleton:
 *  - the SlackConnector registers its already-authed client at boot
 *    (`setSlackClient`), and
 *  - if that hasn't happened (tests / GitHub-only boot), `getSlackClient()` lazily
 *    builds one from `SLACK_BOT_TOKEN`, or returns null when Slack isn't configured.
 *
 * Every call is best-effort: a Slack failure must never break a workflow.
 */

/** A Slack reply target — a channel + the thread root ts to post into. */
export interface SlackTarget {
  channel: string;
  thread: string;
}

/** Slack's safe single-message text length; status checklists stay well under this. */
const MAX_LEN = 3900;

let client: WebClient | null = null;

/** Register the connector's authed WebClient for reuse by workflows. */
export function setSlackClient(c: WebClient): void {
  client = c;
}

/** The shared client, or one built from the bot token, or null if unconfigured. */
export function getSlackClient(): WebClient | null {
  if (client) return client;
  const cfg = slackConfig();
  if (!cfg) return null;
  client = new WebClient(cfg.botToken);
  return client;
}

function toMrkdwn(markdown: string): string {
  const text = markdownToSlackMrkdwn(markdown);
  return text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + "…" : text;
}

/**
 * Post a status message into the thread; returns its `ts` (the handle to edit it
 * later via {@link updateStatus}), or null on any failure / no client.
 */
export async function postStatus(
  target: SlackTarget,
  markdownBody: string,
): Promise<string | null> {
  const c = getSlackClient();
  if (!c) return null;
  try {
    const res = await c.chat.postMessage({
      channel: target.channel,
      thread_ts: target.thread,
      text: toMrkdwn(markdownBody),
    });
    return (res.ts as string | undefined) ?? null;
  } catch (e) {
    console.warn(`[slack-notify] postStatus failed: ${(e as Error).message}`);
    return null;
  }
}

/** Edit a previously-posted status message in place (live progress). */
export async function updateStatus(
  channel: string,
  ts: string,
  markdownBody: string,
): Promise<void> {
  const c = getSlackClient();
  if (!c) return;
  try {
    await c.chat.update({ channel, ts, text: toMrkdwn(markdownBody) });
  } catch (e) {
    console.warn(`[slack-notify] updateStatus failed: ${(e as Error).message}`);
  }
}

/** Post a standalone message into the thread (start ack / terminal ping). */
export async function postMessage(target: SlackTarget, markdownBody: string): Promise<void> {
  const c = getSlackClient();
  if (!c) return;
  try {
    await c.chat.postMessage({
      channel: target.channel,
      thread_ts: target.thread,
      text: toMrkdwn(markdownBody),
    });
  } catch (e) {
    console.warn(`[slack-notify] postMessage failed: ${(e as Error).message}`);
  }
}
