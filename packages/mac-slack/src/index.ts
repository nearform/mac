/**
 * `@nearform/mac-slack` — Slack platform package (full runtime API).
 *
 * Owns the Socket Mode connector, message/status posting helpers, markdown →
 * mrkdwn formatting, Slack message normalization to `EventEnvelope`, and the
 * `slack()` extension. The dependency-light type contract
 * (`SlackCapabilities`/`slackCapabilities`) is published separately from
 * `@nearform/mac-slack/capabilities`.
 *
 * (Extracted from `apps/maintenance/src/mastra/connectors/slack/*` in MAC
 * refactor Phase 4.)
 */

// Slack connector config
export { type SlackConfig } from "./config.js";

// Markdown → Slack mrkdwn (pure)
export { markdownToSlackMrkdwn } from "./mrkdwn.js";

// Outbound notifier helpers (workflow-facing)
export {
  setSlackClient,
  getSlackClient,
  postStatus,
  updateStatus,
  postMessage,
  type SlackTarget,
} from "./notify.js";

// Socket Mode connector + lifecycle
export { SlackConnector, createSlackConnector, startSlackConnector } from "./connector.js";

// The slack() extension
export { slack } from "./extension.js";

// Re-export the capability contract for convenience (also available, dependency
// -light, from "@nearform/mac-slack/capabilities").
export {
  slackCapabilities,
  type SlackCapabilities,
  type SlackTools,
  type SlackFunctions,
  type SlackServers,
  type SlackMetadata,
} from "./capabilities.js";
