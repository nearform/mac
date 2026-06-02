/**
 * `@nearform/mac-slack/capabilities` — the dependency-light type contract.
 *
 * Agent/workflow packages import `SlackCapabilities` and `slackCapabilities`
 * from here as a TYPE-LEVEL contract. Everything below is `import type` except
 * the `slackCapabilities` key itself (which pulls only `capabilityKey` from
 * `@nearform/mac/core`), so importing this module never loads Slack Bolt, the
 * Web API client, or any env loader.
 */
import { capabilityKey } from "@nearform/mac/core";
import type { MacCapabilityKey, PlatformCapabilities } from "@nearform/mac/core";
import type { WebClient } from "@slack/web-api";
import type { SlackTarget } from "./notify.js";

/**
 * There are no Slack agent-facing Mastra tools today (the connector posts
 * directly), so this stays empty rather than inventing a surface.
 */
export type SlackTools = Record<string, never>;

/** Deterministic functions for workflow steps. */
export interface SlackFunctions {
  postMessage(target: SlackTarget, markdownBody: string): Promise<void>;
  postStatus(target: SlackTarget, markdownBody: string): Promise<string | null>;
  updateStatus(channel: string, ts: string, markdownBody: string): Promise<void>;
  setSlackClient(client: WebClient): void;
  getSlackClient(): WebClient | null;
}

/**
 * The connector is exposed via the extension `runtime` hook (start/stop), not a
 * route factory, so there are no composable server surfaces here.
 */
export type SlackServers = Record<string, never>;

/** Small descriptive values for routing / labels / auth checks / observability. */
export interface SlackMetadata {
  allowedUsers: string[];
  homeChannel?: string;
}

export interface SlackCapabilities
  extends PlatformCapabilities<SlackTools, SlackFunctions, SlackServers, SlackMetadata> {}

export const slackCapabilities: MacCapabilityKey<SlackCapabilities> =
  capabilityKey<SlackCapabilities>("slack", "Slack platform");
