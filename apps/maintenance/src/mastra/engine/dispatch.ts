import type { Mastra } from "@mastra/core";
import type { EventEnvelope } from "../connectors/types.js";
import { routeEvent, type RoutingResult, type RouterDeps } from "./router.js";

/**
 * Dispatch a routed event to the thing that handles it. This is the Mastra-side
 * replacement for lastlight's `dispatchWorkflow` closure + `registry.onEvent`
 * handler (src/index.ts): given a `RoutingResult`, either start a Mastra
 * workflow run, post a direct reply, or ignore.
 *
 * Skills the spike has actually ported to workflows:
 *   - `pr-review`            → the `pr-review` workflow ({owner, repo, number})
 *   - `github-orchestrator`  → the `build` workflow (full architect→PR cycle)
 *
 * Every other skill from the route table (issue-triage, explore, security-*,
 * pr-fix, pr-comment, issue-comment, chat, status, …) is M6. For a USER-
 * initiated event (a comment/message) we reply with a "not wired yet" note; for
 * an AUTO event (issue.opened) we just log and skip so we don't spam issues.
 */

/** Skills mapped to a real, runnable Mastra workflow in this milestone. */
const IMPLEMENTED = new Set(["pr-review", "github-orchestrator"]);

function splitRepo(repo: unknown): { owner: string; repo: string } | null {
  if (typeof repo !== "string" || !repo.includes("/")) return null;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  return { owner, repo: name };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * The Slack reply target for a slack-initiated event, threaded into workflow
 * inputData so the run can mirror its progress back into the originating thread
 * (build.ts/pr-review.ts → connectors/slack/notify.ts). Empty for GitHub events,
 * which feed back via the issue status comment instead. The connector sets
 * `raw.channelId`/`raw.threadId` on every Slack envelope.
 */
function slackOrigin(envelope: EventEnvelope): { slackChannel?: string; slackThread?: string } {
  if (envelope.source !== "slack") return {};
  const raw = envelope.raw as Record<string, unknown> | undefined;
  const slackChannel = raw?.channelId;
  const slackThread = raw?.threadId;
  if (typeof slackChannel !== "string" || typeof slackThread !== "string") return {};
  return { slackChannel, slackThread };
}

/**
 * Start a Mastra workflow run and return immediately (fire-and-forget). The
 * webhook/Slack handler must respond fast; the run continues in the background
 * (the `build` run suspends at its approval gate until the ✅/❌ link is hit).
 *
 * `getWorkflow(id)` is keyed by a runtime string, so its generic input type is
 * not known statically here — we intentionally pass `inputData` loosely.
 */
async function startWorkflow(
  mastra: Mastra,
  workflowId: string,
  inputData: Record<string, unknown>,
): Promise<string | null> {
  const workflow = mastra.getWorkflow(workflowId) as any;
  if (!workflow) {
    console.warn(`[dispatch] no workflow registered as "${workflowId}"`);
    return null;
  }
  const run = await workflow.createRun();
  // Fire-and-forget: don't await completion (build suspends at the gate).
  void Promise.resolve(run.start({ inputData })).catch((err: unknown) => {
    console.error(`[dispatch] workflow "${workflowId}" (run ${run.runId}) failed:`, err);
  });
  return run.runId as string;
}

async function dispatchSkill(
  mastra: Mastra,
  skill: string,
  context: Record<string, unknown>,
  envelope: EventEnvelope,
): Promise<void> {
  // pr-review workflow — needs {owner, repo, number}.
  if (skill === "pr-review") {
    const parts = splitRepo(context.repo);
    const number = num(context.prNumber) ?? num(context.issueNumber);
    if (!parts || !number) {
      console.warn(`[dispatch] pr-review missing repo/number: ${JSON.stringify(context)}`);
      return;
    }
    const origin = slackOrigin(envelope);
    const runId = await startWorkflow(mastra, "pr-review", {
      owner: parts.owner,
      repo: parts.repo,
      number,
      ...origin,
    });
    if (origin.slackChannel) {
      await envelope.reply(`🛠️ On it — reviewing ${parts.owner}/${parts.repo}#${number}…`).catch(() => {});
    }
    console.log(`[dispatch] started pr-review for ${parts.owner}/${parts.repo}#${number} (run ${runId})`);
    return;
  }

  // build workflow — the "github-orchestrator" skill (issue → full cycle).
  if (skill === "github-orchestrator") {
    const parts = splitRepo(context.repo);
    const issueNumber = num(context.issueNumber);
    if (!parts || !issueNumber) {
      console.warn(`[dispatch] build missing repo/issueNumber: ${JSON.stringify(context)}`);
      if (envelope.type === "comment.created" || envelope.type === "message") {
        await envelope.reply("I couldn't tell which issue to build — try `@last-light build` on the issue itself.").catch(() => {});
      }
      return;
    }
    const origin = slackOrigin(envelope);
    const runId = await startWorkflow(mastra, "build", {
      owner: parts.owner,
      repo: parts.repo,
      issueNumber,
      issueTitle: str(context.title),
      // For a comment-triggered build the envelope body is the comment text; the
      // issue body isn't in the routed context, so seed with the comment. Build
      // agents fetch the live issue via tools anyway.
      issueBody: str(context.body) || str(context.commentBody),
      baseBranch: "main",
      ...origin,
    });
    // No ack here: build posts its live status message within a second or two
    // (guardrails "installing…" before the slow clone), so an ack is redundant.
    // (pr-review keeps its ack — its first feedback only comes after the review.)
    console.log(`[dispatch] started build for ${parts.owner}/${parts.repo}#${issueNumber} (run ${runId})`);
    return;
  }

  // chat — the conversational surface (Slack threads, etc.). Run the chat
  // agent with Mastra Memory keyed per thread: `thread` = the stable per-thread
  // session key the connector minted (e.g. `slack:<channel>:<ts>`), `resource`
  // = the sender. This is the Mastra-native replacement for lastlight's
  // SessionManager/opencode-serve chat path — Memory persists the thread; no DB
  // session table needed.
  if (skill === "chat") {
    const agent = mastra.getAgent("chat");
    if (!agent) {
      console.warn("[dispatch] chat agent not registered");
      return;
    }
    const message = str(context.message) || envelope.body;
    const thread = str(context.sessionId) || envelope.id;
    const resource = str(context.sender) || "anonymous";
    try {
      const res = await agent.generate(message, { memory: { thread, resource } });
      const text = (res.text ?? "").trim();
      await envelope.reply(text || "…").catch(() => {});
    } catch (err) {
      console.error(`[dispatch] chat generate failed (thread ${thread}):`, err);
      await envelope.reply("⚠️ Something went wrong handling that — try again?").catch(() => {});
    }
    return;
  }

  // approval-response — superseded by the ✅/❌ approval LINKS in the build
  // status comment. Nudge the user there instead of trying to resume by text.
  if (skill === "approval-response") {
    await envelope
      .reply("Use the ✅ **Approve** / ❌ **Reject** links in the build status comment to resolve the gate.")
      .catch(() => {});
    return;
  }

  // Everything else is not yet ported (M6).
  if (!IMPLEMENTED.has(skill)) {
    const userInitiated = envelope.type === "comment.created" || envelope.type === "message";
    if (userInitiated) {
      await envelope
        .reply(`🚧 \`${skill}\` isn't wired up in the Mastra port yet — it's coming in M6.`)
        .catch(() => {});
    } else {
      console.log(`[dispatch] skill "${skill}" not implemented yet — skipping ${envelope.type}`);
    }
  }
}

/**
 * Build the central event handler: normalize already happened (the caller passes
 * an EventEnvelope); this routes + dispatches. Returns the chosen RoutingResult
 * for logging/tests.
 */
export function createDispatcher(mastra: Mastra, deps: RouterDeps = {}) {
  return async function dispatch(envelope: EventEnvelope): Promise<RoutingResult> {
    const result = await routeEvent(envelope, deps);
    switch (result.action) {
      case "ignore":
        console.log(`[dispatch] ignore (${envelope.type}): ${result.reason}`);
        break;
      case "reply":
        await envelope.reply(result.message).catch((e: unknown) => {
          console.warn(`[dispatch] reply failed: ${(e as Error).message}`);
        });
        break;
      case "skill":
        await dispatchSkill(mastra, result.skill, result.context, envelope);
        break;
    }
    return result;
  };
}
