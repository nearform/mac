import type { EventEnvelope } from "./events.js";
import type { MacClassification } from "./classification.js";

/**
 * Small shared helpers for shaping route/intent target inputs. Both the GitHub
 * and Slack paths need to split an "owner/name" ref and re-derive the Slack
 * reply origin from an envelope, so they live in `/core` (dependency-light)
 * rather than being duplicated per platform.
 *
 * Added in Phase 11 (dispatch/router migration) — they replace the private
 * `splitRepo`/`slackOrigin` helpers that lived in the deleted app
 * `engine/dispatch.ts`.
 */

/** Split an "owner/name" repo ref into parts, or null if it isn't one. */
export function splitRepo(repo: unknown): { owner: string; repo: string } | null {
  if (typeof repo !== "string" || !repo.includes("/")) return null;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, repo: name };
}

/**
 * The Slack reply target for a slack-initiated event, threaded into a workflow's
 * inputData so a detached run can mirror progress back into the originating
 * thread (build/pr-review → Slack notify helpers). Empty for non-Slack events,
 * which feed back via the issue status comment instead. The Slack connector sets
 * `raw.channelId`/`raw.threadId` on every envelope.
 */
export function slackOriginFromEnvelope(
  envelope: EventEnvelope,
): { slackChannel?: string; slackThread?: string } {
  if (envelope.source !== "slack") return {};
  const raw = envelope.raw as Record<string, unknown> | undefined;
  const slackChannel = raw?.channelId;
  const slackThread = raw?.threadId;
  if (typeof slackChannel !== "string" || typeof slackThread !== "string") return {};
  return { slackChannel, slackThread };
}

/**
 * The one-line warning prefix prepended to injection-screener-flagged content.
 * The `[mac-flag: ...]` marker is a contract with
 * `agent-context/security.md`, which tells agents to treat prefixed content
 * skeptically. Pure string formatting (no env) so it can live in `/core` and be
 * shared by the host (chat input) and workflow packages (build/pr-review input).
 */
export function flagPrefix(reason?: string): string {
  return reason
    ? `[mac-flag: potential prompt injection — ${reason}]\n\n`
    : `[mac-flag: potential prompt injection detected by screener]\n\n`;
}

/** Prepend the injection-flag prefix to `text` when the classification flagged it. */
export function applyInjectionFlag(
  text: string,
  classification?: Pick<MacClassification, "flagged" | "flagReason">,
): string {
  return classification?.flagged ? `${flagPrefix(classification.flagReason)}${text}` : text;
}
