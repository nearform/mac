import type { EventEnvelope, EventType } from "./events.js";
import type { MacClassification, MacClassifier } from "./classification.js";

/**
 * The contribution-based routing model the host assembles (MAC refactor
 * Phase 2 types; wired by `createMacApp` in Phase 6; generalized into a
 * classifier pipeline in Phase 11). Extensions and workflow/agent definitions
 * contribute default `MacRouteContribution[]` and `MacClassifierIntent[]`; all
 * overrides live in one place — the host `routing` block (`MacRoutingConfig`).
 *
 * The route key scheme is `<source>.<event-or-intent>`: for deterministic
 * events the suffix is the event (`github.pr_opened`); for ambiguous human text
 * it is the matched intent id (`slack.build`).
 */

/** Context passed to a route's `when` / `input` / `message` callbacks. */
export interface RouteContext {
  envelope: EventEnvelope;
  /** The classifier's result, when the host classified this event. */
  classification?: MacClassification;
  /** The resolved `<source>.<event-or-intent>` route key, when known. */
  routeKey?: string;
  /** Set when a reply-gate short-circuit matched a paused, reply-awaiting run. */
  replyGate?: { workflowRunId: string };
}

export type MacRouteTarget =
  | { type: "workflow"; id: string; input?: (ctx: RouteContext) => Record<string, unknown> }
  | { type: "agent"; id: string; input?: (ctx: RouteContext) => string | Record<string, unknown> }
  | { type: "reply"; message: string | ((ctx: RouteContext) => string) }
  | { type: "ignore"; reason: string };

export interface MacRouteContribution {
  id: string;
  source?: string;
  eventTypes?: EventType[];
  priority?: number;
  when?: (ctx: RouteContext) => boolean | Promise<boolean>;
  target: MacRouteTarget;
}

export interface MacClassifierIntent {
  id: string;
  description: string;
  examples?: string[];
  /**
   * Preconditions the host enforces before running `target`. On a *missing*
   * repo/issue the host falls back to the default intent (`isDefault`) if one
   * exists, else to the unroutable reply; on an *unmanaged* repo or a
   * non-maintainer sender it replies with a refusal.
   */
  requires?: {
    /** A repo must be resolvable (from the envelope or the classification). */
    repo?: boolean;
    /** An issue/PR number must be resolvable. */
    issueNumber?: boolean;
    /** The resolved repo must pass the managed-repo check. Implies `repo`. */
    managedRepo?: boolean;
    /** The sender must be a maintainer (GitHub author association). */
    maintainer?: boolean;
  };
  /** Marks the catch-all intent the host routes to when nothing else matches (e.g. CHAT). */
  isDefault?: boolean;
  target: MacRouteTarget;
}

/** Reply-gate lookup for a paused, reply-awaiting workflow run (socratic explore flow). */
export type ReplyGateLookup = (
  triggerId: string,
) => { workflowRunId: string } | null | undefined;

/**
 * Pre-rule guard configuration for the host dispatch pipeline. These gates run
 * before classification on `comment.created` events. All fields are optional;
 * when `mentionPattern` is omitted the mention/maintainer/command gates are
 * skipped entirely (a generic host with no bot handle just classifies every
 * comment). The reference app supplies `/@mac-nf\b/i` here.
 */
export interface MacGuardConfig {
  /** The bot @mention pattern. Only mentioned comments are acted on; others are ignored. */
  mentionPattern?: RegExp;
  /** Author associations allowed to command the bot. Defaults to OWNER/MEMBER/COLLABORATOR. */
  maintainerRoles?: string[];
  /** Reply to a non-maintainer who mentions the bot. */
  nonMaintainerReply?: string | ((ctx: RouteContext) => string);
  /** Reply when a maintainer issues an `approve`/`reject` text command (nudge to the links). */
  approvalReply?: string | ((ctx: RouteContext) => string);
  /** Reply when a mentioned comment classifies to nothing actionable (and there is no default intent). */
  unroutableReply?: string | ((ctx: RouteContext) => string);
}

/**
 * The single place routing overrides live (referenced by `MacAppConfig`).
 * Extensions only contribute defaults; they never take a `routes` option.
 */
export interface MacRoutingConfig {
  /** Include the built-in default route table. Defaults to true. */
  includeDefaults?: boolean;
  /** Override the target for a `<source>.<event-or-intent>` route/intent key. */
  overrideTargets?: Record<string, MacRouteTarget>;
  /** Additional custom routes, appended after defaults and extension contributions. */
  add?: MacRouteContribution[];
  classifier?: {
    /**
     * The classifier the host calls for events that need it. When omitted but
     * intents exist and a model is set, the host builds the default LLM
     * classifier from the merged catalogue.
     */
    classify?: MacClassifier;
    /** Additional intents merged into the catalogue (these become live in Phase 11). */
    extraIntents?: MacClassifierIntent[];
  };
  /** Reply-gate lookup for paused explore runs (platform-neutral; injected by the app). */
  replyGate?: ReplyGateLookup;
  /**
   * Is this repo one the app is allowed to operate on? When omitted the host
   * reads `github` capability metadata (`managedRepos`); when that is absent
   * too, no managed-repo gating is applied.
   */
  isManagedRepo?: (repo: string | undefined | null) => boolean;
  /** The managed-repo allowlist, for the unmanaged-repo refusal message. */
  managedRepos?: () => string[];
  /** Pre-rule guards (mention/maintainer/approval) run before classification. */
  guards?: MacGuardConfig;
}
