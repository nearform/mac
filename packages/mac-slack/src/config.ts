/**
 * Slack connector configuration. Config enters the system at the app boundary
 * (the app reads env and passes a resolved `SlackConfig` in); reusable package
 * code never reads the process environment for these values.
 */
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
