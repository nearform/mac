import { App } from "@slack/bolt";
import type { EventEnvelope, DispatchFn } from "@nearform/mac/core";
import type { SlackConfig } from "./config.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";
import { setSlackClient } from "./notify.js";

/**
 * Slack connector (Socket Mode) — the Mastra-native re-home of the original
 * `SlackConnector` + `MessagingConnector` base.
 *
 * Deliberately self-contained: it folds in the base class's gating logic
 * (allowlist, DM-vs-channel, thread continuation) but DROPS the DB-backed
 * `SessionManager`. Conversation memory is now Mastra `Memory`, keyed per
 * Slack thread by the chat agent (see engine/dispatch.ts → `chat` skill).
 * The only state we keep locally is an in-memory set of "active" thread keys,
 * so a follow-up reply in a thread the bot is already in continues without a
 * fresh @mention. (Lost on restart — acceptable for the spike; the durable
 * conversation history lives in Memory.)
 *
 * Transport-wise this stays a real long-running Socket Mode WebSocket, started
 * at boot from `server.ts` (we own the server now, so no lazy-start hack and no
 * "open a socket during `mastra build`" problem).
 */

/** Rotating status messages shown while the agent is thinking. */
const THINKING_MESSAGES = [
  "Thinking...",
  "Pondering the cosmos...",
  "Consulting the codebase...",
  "Rummaging through repos...",
  "Brewing a response...",
  "Crunching context...",
  "Reading between the lines...",
  "Warming up the neurons...",
  "Assembling thoughts...",
  "Almost there...",
];

/** Slack's per-message text limit (chars); we chunk anything longer. */
const SLACK_MAX_LEN = 3000;

export class SlackConnector {
  readonly name = "slack";
  private app: App;
  private config: SlackConfig;
  private dispatch: DispatchFn;
  /** Resolved bot user id (e.g. `U123`), used for @mention detection/stripping. */
  private botUserId: string | null = null;
  /** Slack user id → display name (cached). */
  private userCache = new Map<string, string>();
  /** `${channelId}:${threadTs}` keys the bot is actively participating in. */
  private activeThreads = new Set<string>();

  constructor(config: SlackConfig, dispatch: DispatchFn) {
    this.config = config;
    this.dispatch = dispatch;
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.setupListeners();
  }

  async start(): Promise<void> {
    // Resolve our own bot user id so we can detect/strip `<@U…>` mentions.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = (auth.user_id as string | undefined) ?? null;
    } catch (err) {
      console.warn(`[slack] auth.test failed — mention detection degraded: ${(err as Error).message}`);
    }
    // Share our authed client so detached workflow runs can post progress back to
    // the initiating thread (notify.ts → build/pr-review feedback).
    setSlackClient(this.app.client);
    await this.app.start();
    console.log(`[slack] Connected via Socket Mode (bot ${this.botUserId ?? "unknown"})`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
    console.log("[slack] Disconnected");
  }

  // ── Slack event wiring ──────────────────────────────────────────────────

  private setupListeners(): void {
    // All message events (DMs, channels, groups). Bolt also fires app_mention
    // for explicit @mentions; we rely on `message` alone + our own mention
    // detection to avoid handling the same message twice.
    this.app.message(async ({ message }) => {
      const msg = message as Record<string, any>;
      if (msg.subtype) return; // edits/deletes/joins/etc.
      if (!msg.user || !msg.text) return;
      if (msg.bot_id) return; // ignore other bots (and ourselves)

      const username = await this.resolveUsername(msg.user);
      const isDM = msg.channel_type === "im";
      const isMention = this.botUserId ? String(msg.text).includes(`<@${this.botUserId}>`) : false;

      await this.handleIncomingMessage({
        platformUserId: msg.user,
        platformUsername: username,
        channelId: msg.channel,
        threadId: msg.thread_ts || null,
        messageId: msg.ts,
        text: msg.text,
        team: (msg.team as string | undefined) || undefined,
        isDM,
        isMention,
        raw: msg,
      });
    });
  }

  // ── Core gating + envelope construction (ported from MessagingConnector) ──

  private async handleIncomingMessage(params: {
    platformUserId: string;
    platformUsername: string;
    channelId: string;
    threadId: string | null;
    messageId: string;
    text: string;
    team?: string;
    isDM: boolean;
    isMention: boolean;
    raw: unknown;
  }): Promise<void> {
    const { platformUserId, platformUsername, channelId, threadId, messageId, text, team, isDM, isMention, raw } =
      params;

    // Allowlist: when configured, only listed user IDs may interact.
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(platformUserId)) {
      console.log(`[slack] ignoring unauthorized user ${platformUsername} (${platformUserId})`);
      return;
    }

    // In channels, only act on an @mention or a reply inside a thread we're
    // already participating in. DMs always get a response.
    if (!isDM && !isMention) {
      const threadKey = threadId ? `${channelId}:${threadId}` : null;
      if (!threadKey || !this.activeThreads.has(threadKey)) return;
    }

    const cleanText = this.stripBotMention(text).trim();
    if (!cleanText) return;

    // The thread anchor for replies/typing: an existing thread's parent ts, or
    // (for a fresh DM/top-level mention) this message's own ts, which becomes
    // the root of a new thread once we reply into it.
    const replyThreadId = threadId || messageId;
    this.activeThreads.add(`${channelId}:${replyThreadId}`);

    // Stable per-thread key — used both as the EventEnvelope id seed and as the
    // Mastra Memory thread id downstream (chat skill).
    const sessionId = `slack:${channelId}:${replyThreadId}`;

    // Acknowledge with a typing/processing indicator (best-effort).
    void this.showTyping(channelId, messageId, replyThreadId);

    const reply = async (md: string): Promise<void> => {
      void this.clearTyping(channelId, replyThreadId);
      for (const chunk of this.chunkMessage(md)) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: markdownToSlackMrkdwn(chunk),
          thread_ts: replyThreadId,
        });
      }
    };

    const envelope: EventEnvelope = {
      id: `slack-${messageId}`,
      source: "slack",
      type: "message",
      sender: platformUsername,
      senderIsBot: false,
      body: cleanText,
      raw: {
        ...(typeof raw === "object" && raw !== null ? raw : {}),
        sessionId,
        platformUserId,
        channelId,
        threadId: replyThreadId,
        team,
      },
      reply,
      timestamp: new Date(),
    };

    try {
      await this.dispatch(envelope);
    } catch (err) {
      console.error(`[slack] dispatch failed for ${envelope.id}:`, err);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Strip our own `<@U…>` mention from the message text. */
  private stripBotMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
  }

  /** Resolve a Slack user id to a display name (cached). */
  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    try {
      const result = await this.app.client.users.info({ user: userId });
      const username = result.user?.name || result.user?.real_name || userId;
      this.userCache.set(userId, username);
      return username;
    } catch {
      return userId;
    }
  }

  /** Show a processing indicator; falls back to an emoji reaction. */
  private async showTyping(channelId: string, messageId: string, threadRootId: string): Promise<void> {
    try {
      // thread_ts MUST be the thread root — passing a reply's ts silently errors.
      await this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadRootId,
        status: "Thinking...",
        loading_messages: THINKING_MESSAGES,
      });
    } catch {
      try {
        await this.app.client.reactions.add({ channel: channelId, timestamp: messageId, name: "eyes" });
      } catch {
        // Reaction may already exist / be invalid — non-critical.
      }
    }
  }

  /** Clear the processing indicator (best-effort). */
  private async clearTyping(channelId: string, threadRootId: string): Promise<void> {
    try {
      await this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadRootId,
        status: "",
      });
    } catch {
      // Non-critical — clears on its own.
    }
  }

  /** Split a long message into chunks that fit Slack's per-message limit. */
  private chunkMessage(text: string, maxLength = SLACK_MAX_LEN): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }
      let breakPoint = remaining.lastIndexOf("\n", maxLength);
      if (breakPoint < maxLength * 0.5) breakPoint = remaining.lastIndexOf(" ", maxLength);
      if (breakPoint < maxLength * 0.3) breakPoint = maxLength;
      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }
    return chunks;
  }
}

/**
 * Create the Slack connector with an explicit start/stop lifecycle (the target
 * API used by the `slack()` extension's `runtime` hook). Construction is
 * side-effect-free; the Socket Mode WebSocket opens only on `start()`.
 */
export function createSlackConnector(args: {
  config: SlackConfig;
  dispatch: DispatchFn;
}): { start(): Promise<void>; stop(): Promise<void> } {
  const connector = new SlackConnector(args.config, args.dispatch);
  return {
    start: () => connector.start(),
    stop: () => connector.stop(),
  };
}

/**
 * Construct + start the Slack connector. Returns the connector (for shutdown).
 * Called once at boot from server.ts. Thin wrapper over the underlying
 * connector so the back-compat caller keeps a single call site.
 */
export async function startSlackConnector(
  config: SlackConfig,
  dispatch: DispatchFn,
): Promise<SlackConnector> {
  const connector = new SlackConnector(config, dispatch);
  await connector.start();
  return connector;
}
