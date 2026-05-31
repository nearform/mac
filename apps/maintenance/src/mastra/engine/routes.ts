/**
 * Event → skill route table. Ported from lastlight's `defaultRouteConfig()`
 * (src/config.ts). lastlight made these overridable via its YAML config overlay;
 * the spike drops the overlay (MIGRATION.md), so these are the static defaults.
 *
 * NOTE: many of these skills (issue-triage, explore, security-*, pr-fix, …) are
 * not yet implemented in the Mastra port (M6). The router still classifies to
 * them; the dispatcher (engine/dispatch.ts) maps the implemented ones to real
 * workflows and replies with a "not wired yet" note for the rest.
 */

export interface RouteConfig {
  github: Record<string, string>;
  slack: Record<string, string>;
}

export function defaultRouteConfig(): RouteConfig {
  return {
    github: {
      issue_opened: "issue-triage",
      issue_reopened: "issue-triage",
      pr_opened: "pr-review",
      pr_synchronize: "pr-review",
      pr_reopened: "pr-review",
      approval_response: "approval-response",
      security_review: "security-review",
      pr_fix: "pr-fix",
      pr_comment: "pr-comment",
      issue_build: "github-orchestrator",
      issue_explore: "explore",
      issue_comment: "issue-comment",
      security_feedback: "security-feedback",
      explore_reply: "explore-reply",
    },
    slack: {
      reset: "chat-reset",
      status: "status-report",
      approve: "approval-response",
      reject: "approval-response",
      build: "github-orchestrator",
      triage: "issue-triage",
      review: "pr-review",
      security: "security-review",
      explore: "explore",
      chat: "chat",
      explore_reply: "explore-reply",
    },
  };
}

export function getRoutes(): RouteConfig {
  return defaultRouteConfig();
}
