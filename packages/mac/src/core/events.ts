/**
 * The normalized event contract — the heart of MAC's platform-neutral core.
 *
 * Platform connectors (GitHub webhook, Slack Socket Mode, future Linear/email)
 * translate raw platform payloads into an `EventEnvelope` and hand it to a
 * `DispatchFn`. The router and workflows only ever see envelopes, never raw
 * platform SDKs.
 *
 * Moved from `apps/maintenance/src/mastra/connectors/types.ts` (MAC refactor
 * Phase 2). The unused `EventEmitter`-based `Connector` interface from that file
 * was intentionally NOT carried over — the system dispatches plain envelopes via
 * `DispatchFn` and manages long-running connectors through explicit
 * `runtime.start()/stop()` hooks (see `MacExtensionResult`).
 */
export interface EventEnvelope {
  /** Unique event ID (for deduplication). */
  id: string;
  /** Source connector name (e.g. "github", "slack"). */
  source: string;
  /** Normalized event type. */
  type: EventType;
  /** Repository in owner/repo format. */
  repo?: string;
  /** Issue or PR number. */
  issueNumber?: number;
  /** PR number (distinct from issue for PR-specific events). */
  prNumber?: number;
  /** Login/username of the sender. */
  sender: string;
  /** Whether sender is a bot. */
  senderIsBot: boolean;
  /** Event body text (issue body, comment body, PR body, etc.). */
  body: string;
  /** Title (for issues/PRs). */
  title?: string;
  /** Labels on the issue/PR. */
  labels?: string[];
  /** GitHub author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE). */
  authorAssociation?: string;
  /** Original platform payload (for connector-specific logic). */
  raw: unknown;
  /**
   * Reply on the same platform/thread.
   *
   * Known limitation (see the refactor doc): this closure is not serializable,
   * so an envelope cannot be queued or snapshotted. Kept deliberately for now;
   * a serializable `ReplyTarget` is deferred until event durability is a goal.
   */
  reply: (msg: string) => Promise<void>;
  /** Timestamp of the event. */
  timestamp: Date;
}

export type EventType =
  | "issue.opened"
  | "issue.reopened"
  | "issue.closed"
  | "pr.opened"
  | "pr.synchronize" // new commits pushed to a PR's branch
  | "pr.reopened"
  | "pr.closed"
  | "pr.merged"
  | "comment.created"
  | "pr_review.submitted"
  | "pr_review_comment.created"
  | "message"; // generic message from chat platforms (Slack, Discord)

/**
 * The single way events enter the system. Connectors depend on this function
 * type, not on a concrete Mastra app.
 */
export type DispatchFn = (envelope: EventEnvelope) => Promise<unknown>;
