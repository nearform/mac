import { createWorkflow, createStep, type Workflow } from "@mastra/core/workflows";
import type { Workspace } from "@mastra/core/workspace";
import { z } from "zod";
import type { GithubCapabilities } from "@nearform/mac-github/capabilities";
import type { SlackCapabilities } from "@nearform/mac-slack/capabilities";
import {
  defineWorkflow,
  splitRepo,
  slackOriginFromEnvelope,
  applyInjectionFlag,
  type MacWorkflowDefinition,
  type MacAgentRegistry,
  type WorkspaceFactory,
  type ApprovalLinkBuilder,
  type RouteContext,
} from "@nearform/mac/core";
import { githubCapabilities } from "@nearform/mac-github/capabilities";
import { slackCapabilities } from "@nearform/mac-slack/capabilities";
import { agentCapabilities } from "../capabilities.js";
import { parseGuardrails } from "../parsers/guardrails.js";
import { parseVerdict } from "../parsers/verdict.js";
import { buildAgentContext } from "../agents/runtime.js";
import {
  cloneRepo,
  createBranch,
  installDependencies,
  workingDiff,
  changedFiles,
  writeArtifact,
  commitAndPush,
} from "./git.js";

/**
 * build workflow factory — ported from the reference app's `workflows/build.ts`
 * (MAC refactor Phase 8): guardrails → architect → (post_architect approval
 * gate) → executor → reviewer fix-loop → finalize → PR.
 *
 * GITHUB-CENTRIC
 * --------------
 * The build treats the source issue + branch as the primary surface
 * (GitHub-native):
 *  - Each phase COMMITS its work (code + `.mac/<issueDir>/` artifacts) and
 *    PUSHES the `mac/issue-<n>` branch, so progress is visible on GitHub
 *    as it happens. Git is deterministic (git.ts); agents only produce content.
 *  - One live STATUS COMMENT is posted on the issue and EDITED after every phase
 *    (a checklist with per-step status emoji + branch/PR links), plus a 🚀
 *    reaction on build start. All issue writes are best-effort — a missing issue
 *    never fails the build.
 *  - The run ends by opening a PR (createPr, default true).
 *
 * Per-step structure is deliberate so a future step can map a 👍/👎 reaction on
 * a phase to a Mastra scorer/eval for that agent (see PHASES + publishPhase).
 *
 * The `post_architect` gate is a real Mastra suspend()/resume(); wiring approval
 * to an issue comment is deferred to the GitHub webhook work.
 *
 * DEPENDENCY INJECTION (Phase 8)
 * ------------------------------
 * No env reads, no app-config knowledge: GitHub arrives as configured
 * capabilities (token broker + octokit + issue functions), the build agents as
 * registered instances (`deps.agents.byId(...)`), the per-run checkout as an
 * injected `workspaceFactory`, the signed approval links as an injected
 * `ApprovalLinkBuilder`, and Slack as an optional injected poster.
 *
 * State threading: every step shares one `buildState` schema (REQUIRED fields,
 * no zod defaults — defaults would make input/output types diverge and break the
 * .then()/.dountil() chain). The first step populates it; later steps augment it.
 */

// ── Per-step skill policy ────────────────────────────────────────────────────
//
// Which skills each build step's agent loads. This is the WORKFLOW's call (the
// step owns its altitude), not the skill loader's: each step passes its set to
// `buildAgentContext`, the agent's workspace resolver forwards it to the
// workspace factory, and the app wires only those skills. Keep each set tight.
//
// Note: the review step uses `build-reviewer`, which is workspace-less by design
// (deterministic, diff-in-prompt), so it carries no skills here — review skills
// apply to the PR `reviewer` in pr-review.ts.
const SKILLS = {
  guardrails: ["assure-guardrails"],
  architect: ["architect", "codebase-inspection"],
  executor: ["test-driven-development", "systematic-debugging", "codebase-inspection"],
  fix: ["systematic-debugging", "test-driven-development"],
} as const;

// ── Schemas ────────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  issueTitle: z.string().optional().default(""),
  issueBody: z.string().optional().default(""),
  baseBranch: z.string().optional().default("main"),
  maxCycles: z.number().int().min(0).max(5).optional().default(3),
  // Bootstrap bypass: when the TASK is to set up the missing
  // tooling, let a BLOCKED guardrails check proceed anyway. Off by default →
  // BLOCKED aborts the build.
  bootstrap: z.boolean().optional().default(false),
  // GitHub-centric mode (default on): commit+push each phase to the branch and
  // post/update the live status comment on the issue. Set false for a fully
  // local structural-verify run (clone/edit/diff, no GitHub writes).
  publishProgress: z.boolean().optional().default(true),
  // Open a PR at the end (default on). Requires publishProgress.
  createPr: z.boolean().optional().default(true),
  // Slack reply target (set by dispatch when the run was initiated from Slack) —
  // when present, every phase mirrors the live status into this thread and a
  // terminal ping is posted. Absent for GitHub-initiated runs (Slack is skipped).
  slackChannel: z.string().optional(),
  slackThread: z.string().optional(),
});

const verdictEnum = z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

const progressEntry = z.object({
  key: z.string(),
  label: z.string(),
  status: z.string(),
  detail: z.string().optional(),
});

type ProgressEntry = z.infer<typeof progressEntry>;

const buildState = z.object({
  owner: z.string(),
  repo: z.string(),
  issueNumber: z.number().int().positive(),
  issueTitle: z.string(),
  issueBody: z.string(),
  baseBranch: z.string(),
  maxCycles: z.number().int(),
  bootstrap: z.boolean(),
  publishProgress: z.boolean(),
  createPr: z.boolean(),
  taskId: z.string(),
  // The Mastra workflow runId — threaded through state so renderStatusComment()
  // can build the signed ✅/❌ approval links that resume THIS run (see
  // the injected ApprovalLinkBuilder + the app's server/approval.ts).
  runId: z.string(),
  branch: z.string(),
  issueDir: z.string(),
  ready: z.boolean(),
  guardrailsReport: z.string(),
  plan: z.string(),
  approved: z.boolean(),
  aborted: z.boolean(),
  abortReason: z.string().optional(),
  executorSummary: z.string(),
  cycle: z.number().int(),
  // Undefined until the review loop runs — NOT a "NONE" sentinel.
  lastVerdict: verdictEnum.optional(),
  reviewBody: z.string(),
  diff: z.string(),
  filesChanged: z.array(z.string()),
  // Live issue status comment + per-phase progress (drives the comment body).
  statusCommentId: z.number().optional(),
  progress: z.array(progressEntry),
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  // Slack mirror (when slack-initiated): the reply target + the live message ts
  // (the Slack analogue of statusCommentId — edited in place each phase).
  slackChannel: z.string().optional(),
  slackThread: z.string().optional(),
  slackStatusTs: z.string().optional(),
});

type BuildState = z.infer<typeof buildState>;

// ── Progress model (also the seam for future per-step evals) ─────────────────
//
// `progress` is an ORDERED list of checklist entries. The fixed phases are
// seeded up front; the review loop INSERTS a `Review (cycle N)` / `Fix (cycle N)`
// entry per iteration (before the PR entry), so every iteration shows up in the
// issue comment. Each entry has a stable `key` — the seam a future step can use
// to map a 👍/👎 reaction on a phase to a Mastra scorer for that agent.

const PHASES = [
  { key: "checkout", label: "Checkout" },
  { key: "guardrails", label: "Guardrails" },
  { key: "architect", label: "Architect" },
  { key: "approval", label: "Approval" },
  { key: "executor", label: "Executor" },
  { key: "pr", label: "Pull request" },
] as const;

const EMOJI: Record<string, string> = {
  pending: "⬜",
  running: "🔄",
  done: "✅",
  blocked: "⛔",
  awaiting: "⏸️",
  failed: "❌",
  skipped: "➖",
};

function initProgress(): ProgressEntry[] {
  return PHASES.map((p) => ({ key: p.key, label: p.label, status: "pending" }));
}

/** Update an existing entry's status/detail by key (label preserved). */
function setStatus(
  progress: ProgressEntry[],
  key: string,
  status: string,
  detail?: string,
): ProgressEntry[] {
  return progress.map((e) => (e.key === key ? { ...e, status, detail } : e));
}

/**
 * Upsert a dynamic entry, inserting it before `beforeKey` (e.g. "pr") so the
 * review/fix iterations slot in between Executor and Pull request, in order.
 */
function upsertBefore(
  progress: ProgressEntry[],
  beforeKey: string,
  entry: ProgressEntry,
): ProgressEntry[] {
  if (progress.some((e) => e.key === entry.key)) {
    return progress.map((e) => (e.key === entry.key ? { ...e, ...entry } : e));
  }
  const idx = progress.findIndex((e) => e.key === beforeKey);
  if (idx < 0) return [...progress, entry];
  return [...progress.slice(0, idx), entry, ...progress.slice(idx)];
}

/** Repo-qualified issue ref for logs (e.g. `cliftonc/lastlight#82`) — runs span repos. */
function ref(s: { owner: string; repo: string; issueNumber: number }): string {
  return `${s.owner}/${s.repo}#${s.issueNumber}`;
}

/** GitHub web URL for the triggering issue (clickable in the status comment / Slack). */
function issueUrl(st: BuildState): string {
  return `https://github.com/${st.owner}/${st.repo}/issues/${st.issueNumber}`;
}

/** GitHub web URL for the work branch (clickable in the status comment / Slack). */
function branchUrl(st: BuildState): string {
  return `https://github.com/${st.owner}/${st.repo}/tree/${st.branch}`;
}

/** GitHub web URL for the per-issue artifacts directory on the work branch. */
function artifactsTreeUrl(st: BuildState): string {
  return `https://github.com/${st.owner}/${st.repo}/tree/${st.branch}/.mac/${st.issueDir}`;
}

/** GitHub web URL for a single committed artifact (e.g. architect-plan.md). */
function artifactUrl(st: BuildState, name: string): string {
  return `https://github.com/${st.owner}/${st.repo}/blob/${st.branch}/.mac/${st.issueDir}/${name}`;
}

/** Reaction content accepted by the GitHub addIssueReaction function. */
type ReactionContent = Parameters<
  NonNullable<GithubCapabilities["functions"]>["addIssueReaction"]
>[1]["content"];

export interface BuildDeps {
  /** Configured GitHub capabilities — token broker + createOctokit + issue functions. */
  github: GithubCapabilities;
  /** The registered build agents (guardrails/architect/executor/fix/build-reviewer) by id. */
  agents: MacAgentRegistry;
  /** Per-run checkout factory (local FS+sandbox in dev, remote sandbox in prod). */
  workspaceFactory: WorkspaceFactory;
  /** Builds signed ✅/❌ approval links that resume THIS run. */
  approvalLinks: ApprovalLinkBuilder;
  /** Optional Slack poster — present when a Slack platform is configured. */
  slack?: Pick<
    NonNullable<SlackCapabilities["functions"]>,
    "postStatus" | "updateStatus" | "postMessage"
  >;
  /**
   * Optional branding for the per-run branch this workflow pushes. A consuming
   * app should set this so branches aren't named after the reference app — e.g.
   * `{ branchPrefix: "acme-bot" }` yields `acme-bot/issue-<n>-<run>`. Defaults to
   * `"mac"` to preserve the reference app's behavior.
   *
   * (The `.mac/` on-branch artifact directory and conventional-commit
   * scopes remain fixed for now — the artifact dir is coupled to git
   * exclude-pathspecs and is best parametrized alongside an integration test.)
   */
  branding?: { branchPrefix?: string };
}

export function createBuildWorkflow(deps: BuildDeps): Workflow {
  // A configured GitHub bundle always carries functions.
  const fns = deps.github.functions!;

  // The per-run branch prefix; a consuming app overrides this so pushed branches
  // aren't named after the reference app. Default preserves current behavior.
  const branchPrefix = deps.branding?.branchPrefix ?? "mac";

  // ── Token helpers ──────────────────────────────────────────────────────────

  /** READ-scoped token (clone + read tools). */
  const mintReadToken = async (): Promise<string> =>
    (await fns.tokenBroker.mint("read")).token;

  /** WRITE token (`build` → repo-write: contents + pull_requests) for push + PR. */
  const mintWriteToken = async (): Promise<string> =>
    (await fns.tokenBroker.mint("repo-write")).token;

  /**
   * Resolve the issue title. Only the GitHub webhook trigger carries it on the
   * envelope — Slack/CLI/HTTP triggers don't — so when it's missing we fetch it
   * from the API (we already have a read token in hand for the clone) to avoid a
   * "(untitled)" status comment. Best-effort: a failure leaves the title empty.
   */
  const resolveIssueTitle = async (
    owner: string,
    repo: string,
    issueNumber: number,
    given: string,
    token: string,
  ): Promise<string> => {
    if (given.trim()) return given;
    try {
      const octokit = fns.createOctokit({ token });
      const { data } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      return data.title ?? "";
    } catch (err) {
      console.warn(
        `[build] could not fetch title for ${owner}/${repo}#${issueNumber}:`,
        err,
      );
      return "";
    }
  };

  // ── Context + render helpers ─────────────────────────────────────────────────

  /** The live status comment body — re-rendered (in order) after each update. */
  function renderStatusComment(st: BuildState): string {
    const lines = st.progress.map((e) => {
      const detail = e.detail ? ` — ${e.detail}` : "";
      let line = `- ${EMOJI[e.status] ?? "⬜"} **${e.label}**${detail}`;
      // Render the signed ✅/❌ links INLINE on the Approval row while it's
      // awaiting — clicking one hits /approve (server/approval.ts) and resumes
      // THIS run. They disappear once the gate resolves (status != awaiting).
      if (e.key === "approval" && e.status === "awaiting") {
        line +=
          ` — [✅ Approve](${deps.approvalLinks.link(st.runId, "approve")})` +
          ` · [❌ Reject](${deps.approvalLinks.link(st.runId, "reject")})`;
      }
      return line;
    });
    return [
      `### 🤖 MAC — build for [#${st.issueNumber}](${issueUrl(st)})`,
      "",
      `**${st.issueTitle || "(untitled)"}**`,
      "",
      // Markdown links (not `<sub>` HTML — Slack shows raw HTML). GitHub renders
      // the link; markdownToSlackMrkdwn turns `[text](url)` into `<url|text>`.
      `Branch: [${st.branch}](${branchUrl(st)})`,
      st.prUrl ? `Pull request: ${st.prUrl}` : "",
      "",
      ...lines,
      "",
      `Artifacts: [.mac/${st.issueDir}/](${artifactsTreeUrl(st)}) — updates as the build runs.`,
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  function issueContext(st: BuildState): string {
    return [
      `Repository: ${st.owner}/${st.repo}`,
      `Issue #${st.issueNumber}: ${st.issueTitle}`,
      "",
      st.issueBody || "(no issue body)",
    ].join("\n");
  }

  /** Artifact path under the per-issue `.mac/` subfolder. */
  function artifact(st: BuildState, name: string): string {
    return `${st.issueDir}/${name}`;
  }

  /** Render the per-run `status.md` artifact. */
  function statusMd(st: BuildState, phase: string): string {
    return [
      "# Build status",
      "",
      `- issue: ${st.owner}/${st.repo}#${st.issueNumber} — ${st.issueTitle}`,
      `- branch: ${st.branch}`,
      `- current_phase: ${phase}`,
      `- guardrails_ready: ${st.ready}`,
      `- approved: ${st.approved}`,
      `- review_cycles: ${st.cycle}`,
      `- last_verdict: ${st.lastVerdict ?? "pending"}`,
      st.prUrl ? `- pull_request: ${st.prUrl}` : "",
      st.aborted ? `- aborted: ${st.abortReason ?? "true"}` : "",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  /**
   * Publish a phase: (best-effort) commit+push the branch and create/update the
   * live issue status comment, optionally adding a reaction. Returns the state
   * deltas (`progress`, and `statusCommentId` the first time the comment is
   * created) for the calling step to merge. In local mode (`publishProgress`
   * false) it updates `progress` only and touches nothing on GitHub.
   */
  async function publishPhase(
    st: BuildState,
    ws: Workspace,
    opts: {
      phase?: string;
      status?: string;
      detail?: string;
      commitMessage?: string;
      reaction?: ReactionContent;
    },
  ): Promise<Partial<BuildState>> {
    const progress = opts.phase
      ? setStatus(st.progress, opts.phase, opts.status ?? "done", opts.detail)
      : st.progress;
    const updates: Partial<BuildState> = { progress };

    // Render the status body ONCE — shared by the GitHub comment and the Slack
    // mirror. (Cheap, no I/O.)
    const body = renderStatusComment({ ...st, ...updates } as BuildState);

    // Slack mirror — one live message per run, edited in place each phase. Gated
    // on a slack target only (NOT publishProgress, which gates GitHub writes), so
    // Slack feedback works even for a fully-local run. The `[✅ Approve]/[❌ Reject]`
    // markdown links survive the mrkdwn conversion as Slack links to the same
    // /approve URL, so approval-via-link works from Slack too. Best-effort.
    if (st.slackChannel && st.slackThread && deps.slack) {
      if (st.slackStatusTs) {
        await deps.slack.updateStatus(st.slackChannel, st.slackStatusTs, body);
      } else {
        const ts = await deps.slack.postStatus(
          { channel: st.slackChannel, thread: st.slackThread },
          body,
        );
        if (ts) updates.slackStatusTs = ts;
      }
    }

    if (!st.publishProgress) return updates;

    try {
      const token = await mintWriteToken();
      if (opts.commitMessage) {
        await commitAndPush(ws, {
          owner: st.owner,
          repo: st.repo,
          token,
          branch: st.branch,
          message: opts.commitMessage,
        });
      }
      const octokit = fns.createOctokit({ token });
      if (opts.reaction) {
        try {
          await fns.addIssueReaction(octokit, {
            owner: st.owner,
            repo: st.repo,
            number: st.issueNumber,
            content: opts.reaction,
          });
        } catch (e) {
          console.warn(`[build] reaction failed: ${(e as Error).message}`);
        }
      }
      try {
        if (st.statusCommentId) {
          await fns.updateIssueComment(octokit, {
            owner: st.owner,
            repo: st.repo,
            commentId: st.statusCommentId,
            body,
          });
        } else {
          const c = await fns.addIssueComment(octokit, {
            owner: st.owner,
            repo: st.repo,
            number: st.issueNumber,
            body,
          });
          updates.statusCommentId = c.id;
        }
      } catch (e) {
        console.warn(`[build] status comment failed: ${(e as Error).message}`);
      }
    } catch (e) {
      console.warn(`[build] publishPhase(${opts.phase ?? "refresh"}) failed: ${(e as Error).message}`);
    }
    return updates;
  }

  /**
   * Mark a phase 🔄 running and update the live comment BEFORE the (often slow)
   * work starts, so the issue shows the step has begun. No commit — just the
   * comment. Returns merged state so the caller threads the progress/comment id.
   */
  async function markRunning(
    st: BuildState,
    ws: Workspace,
    phase: string,
    detail?: string,
  ): Promise<BuildState> {
    const upd = await publishPhase(st, ws, { phase, status: "running", detail });
    return { ...st, ...upd } as BuildState;
  }

  /**
   * Terminal Slack ping. Slack doesn't notify on message EDITS, so beyond the
   * live-updated status message we post one final standalone message when the run
   * ends — the user gets a real notification with the outcome + PR link. No-op for
   * GitHub-initiated runs (no slack target). Called from prStep (the step every
   * path — success, abort, no-changes — flows through last).
   */
  async function slackTerminal(st: BuildState): Promise<void> {
    if (!st.slackChannel || !st.slackThread || !deps.slack) return;
    const target = { channel: st.slackChannel, thread: st.slackThread };
    const r = ref(st);
    let msg: string;
    if (st.aborted) {
      msg = `⛔ Build for ${r} aborted — ${st.abortReason ?? "see the issue for details"}.`;
    } else if (st.prUrl) {
      msg = `✅ Build for ${r} complete (verdict: ${st.lastVerdict ?? "n/a"}) — PR: ${st.prUrl}`;
    } else if (st.filesChanged.length === 0) {
      msg = `ℹ️ Build for ${r} finished with no code changes — no PR opened.`;
    } else {
      msg = `✅ Build for ${r} finished (verdict: ${st.lastVerdict ?? "n/a"}). No PR link available.`;
    }
    await deps.slack.postMessage(target, msg);
  }

  // ── Steps ────────────────────────────────────────────────────────────────────

  // Setup: build the run's BuildState, then clone + install deps into the
  // sandbox. Everything downstream (guardrails included) receives a ready,
  // checked-out workspace — guardrails is then purely a readiness check.
  const setupStep = createStep({
    id: "setup",
    inputSchema: triggerSchema,
    outputSchema: buildState,
    execute: async ({ inputData, runId, mastra }) => {
      const logger = mastra.getLogger();
      // runId in the taskId isolates each run's checkout (an interrupted run can't
      // poison the next). Resume keeps the same runId, so later steps reuse it.
      // Branch is per-RUN: it includes the short runId so every build starts a
      // FRESH branch off base with no prior run's `.mac/` state on it
      // (continuing a canonical per-issue branch resurrected stale guardrails/plan
      // artifacts and confused the agents). Plain (non-force) push, own PR per run.
      // Trade-off: branches/PRs accumulate on the remote (cleanup is TODO).
      const shortRun = runId.slice(0, 8);
      const taskId = `build-${inputData.owner}-${inputData.repo}-${inputData.issueNumber}-${shortRun}`;
      const branch = `${branchPrefix}/issue-${inputData.issueNumber}-${shortRun}`;
      const issueDir = `issue-${inputData.issueNumber}`;

      const ws = deps.workspaceFactory.create(taskId);
      await ws.init();

      // One read token for both the title lookup and the clone below.
      const token = await mintReadToken();
      const issueTitle = await resolveIssueTitle(
        inputData.owner,
        inputData.repo,
        inputData.issueNumber,
        inputData.issueTitle,
        token,
      );

      logger.info(
        `[build] ${ref(inputData)} "${issueTitle || "(untitled)"}" — starting build (branch ${branch}, run ${shortRun})`,
      );

      // Initial state + immediate "build started" signal: post the live status
      // comment with checkout 🔄 running and a 🚀 reaction BEFORE the slow
      // clone/npm-install, so the issue lights up right away.
      let state: BuildState = {
        owner: inputData.owner,
        repo: inputData.repo,
        issueNumber: inputData.issueNumber,
        issueTitle,
        issueBody: inputData.issueBody,
        baseBranch: inputData.baseBranch,
        maxCycles: inputData.maxCycles,
        bootstrap: inputData.bootstrap,
        publishProgress: inputData.publishProgress,
        createPr: inputData.createPr,
        taskId,
        runId,
        branch,
        issueDir,
        ready: false,
        guardrailsReport: "",
        plan: "",
        approved: false,
        aborted: false,
        executorSummary: "",
        cycle: 0,
        reviewBody: "",
        diff: "",
        filesChanged: [],
        progress: initProgress(),
        slackChannel: inputData.slackChannel,
        slackThread: inputData.slackThread,
      };
      state = {
        ...state,
        ...(await publishPhase(state, ws, {
          phase: "checkout",
          status: "running",
          detail: "cloning repository…",
          reaction: "rocket",
        })),
      };

      // Deterministic clone + branch in the sandbox (workflow owns git).
      logger.info(
        `[build] ${ref(state)} checkout: cloning ${inputData.owner}/${inputData.repo}@${inputData.baseBranch}…`,
      );
      await cloneRepo(ws, {
        owner: inputData.owner,
        repo: inputData.repo,
        token,
        baseBranch: inputData.baseBranch,
      });
      await createBranch(ws, branch);
      logger.info(`[build] ${ref(state)} checkout: clone complete (branch ${branch})`);

      // Install dependencies DETERMINISTICALLY (workflow-owned, like git) before
      // the agents run. Previously the agent was asked to install "if needed" and
      // sometimes skipped it → false BLOCK ("vitest: command not found"). Doing it
      // here guarantees the test runner is on disk for guardrails AND the later
      // executor/review phases (same checkout). Best-effort; the log is committed
      // as an artifact, and a real failure surfaces when the agent can't run tests.
      state = {
        ...state,
        ...(await publishPhase(state, ws, {
          phase: "checkout",
          status: "running",
          detail: "installing dependencies…",
        })),
      };
      logger.info(`[build] ${ref(state)} checkout: installing dependencies…`);
      const installResult = await installDependencies(ws);
      logger.info(
        `[build] ${ref(state)} checkout: deps install ran=${installResult.ran} ok=${installResult.ok} pm=${installResult.packageManager}`,
      );
      await writeArtifact(ws, artifact(state, "deps-install.log"), installResult.output);
      await writeArtifact(ws, artifact(state, "status.md"), statusMd(state, "checkout"));

      const depsDetail = !installResult.ran
        ? "cloned, no deps to install"
        : installResult.ok
          ? "cloned, deps installed"
          : "cloned, deps install failed";
      const upd = await publishPhase(state, ws, {
        phase: "checkout",
        status: "done",
        detail: depsDetail,
        commitMessage: `chore(mac): checkout for #${state.issueNumber}`,
      });
      logger.info(`[build] ${ref(state)} checkout: ${depsDetail}`);
      return { ...state, ...upd };
    },
  });

  // Guardrails: a readiness check on the already-checked-out workspace —
  // confirm a usable test command exists before any code is written. BLOCKED
  // aborts the build (unless this is a bootstrap task).
  const guardrailsStep = createStep({
    id: "guardrails",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      if (st.aborted) return st; // setup failed upstream — skip.

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();
      logger.info(`[build] ${ref(st)} guardrails: checking test tooling…`);
      st = await markRunning(st, ws, "guardrails", "checking test framework…");

      // Pre-flight: confirm the checkout has a usable test command.
      const agent = deps.agents.byId("guardrails");
      const res = await agent.generate(
        `Run the pre-flight guardrails check on this checkout of ${st.owner}/${st.repo}.`,
        { requestContext: buildAgentContext(st.taskId, undefined, SKILLS.guardrails), tracingContext },
      );
      const { ready, report } = parseGuardrails(res.text ?? "");

      // BLOCKED aborts the build unless this is a bootstrap task.
      const blocked = !ready && !st.bootstrap;
      logger.info(
        `[build] ${ref(st)} guardrails: ${ready ? "READY" : blocked ? "BLOCKED — aborting build" : "not ready (bootstrap bypass)"}`,
      );

      const result: BuildState = {
        ...st,
        ready,
        guardrailsReport: report,
        aborted: blocked,
        abortReason: blocked
          ? "Guardrails BLOCKED — no usable test framework. See guardrails-report.md."
          : undefined,
      };

      await writeArtifact(
        ws,
        artifact(result, "guardrails-report.md"),
        `# Guardrails report\n\nStatus: ${ready ? "READY" : "BLOCKED"}` +
          (blocked ? " (aborting build)" : st.bootstrap && !ready ? " (bootstrap bypass)" : "") +
          `\n\n${report || "(no report text)"}\n`,
      );
      await writeArtifact(ws, artifact(result, "status.md"), statusMd(result, "guardrails"));

      const upd = await publishPhase(result, ws, {
        phase: "guardrails",
        status: blocked ? "blocked" : "done",
        detail: ready ? "test framework OK" : blocked ? "BLOCKED" : "bootstrap bypass",
        commitMessage: `chore(mac): guardrails for #${result.issueNumber}`,
      });
      return { ...result, ...upd };
    },
  });

  const architectStep = createStep({
    id: "architect",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      if (st.aborted) return st; // guardrails BLOCKED — skip.

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();
      logger.info(`[build] ${ref(st)} architect: analyzing codebase & planning…`);
      st = await markRunning(st, ws, "architect", "analyzing the codebase…");

      const agent = deps.agents.byId("architect");
      // Workspace-only: no GitHub read token (the checkout is already on disk and
      // the GitHub read tools just churn weaker models — see createArchitectAgent).
      const promptText = [
        "Produce the implementation plan for this issue.",
        "",
        issueContext(st),
        "",
        st.guardrailsReport
          ? `Guardrails report (test/lint/typecheck commands):\n${st.guardrailsReport}`
          : "",
      ].join("\n");

      // Architect step budget: explore for a bounded number of tool-steps, then
      // FORCE the plan. Weak local models don't stop exploring on their own (they
      // loop on grep/read until the global maxSteps cap, then return empty text).
      // After ARCHITECT_EXPLORE_STEPS we set toolChoice:"none" via prepareStep, so
      // the next step has no tools and the model MUST emit the plan as text — using
      // the context it already gathered. This overrides the (high) global maxSteps
      // for this phase only; the executor/reviewer keep the larger budget.
      const ARCHITECT_EXPLORE_STEPS = 40;

      // Empty-plan guard: even with the forced final answer, retry once if the
      // model still returns blank, before giving up.
      let plan = "";
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const res = await agent.generate(promptText, {
          requestContext: buildAgentContext(st.taskId, undefined, SKILLS.architect),
          tracingContext,
          maxSteps: ARCHITECT_EXPLORE_STEPS + 2,
          // Once the exploration budget is spent, disable tools so the model is
          // forced to write the plan instead of calling another tool.
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            stepNumber >= ARCHITECT_EXPLORE_STEPS ? { toolChoice: "none" as const } : undefined,
        });
        plan = (res.text ?? "").trim();
        if (plan) break;
        logger.warn(
          `[build] ${ref(st)} architect: empty plan on attempt ${attempt}/${maxAttempts}` +
            (attempt < maxAttempts ? " — retrying" : ""),
        );
      }

      // Still nothing — abort loudly rather than proceed with an empty plan (the
      // executor would otherwise improvise from the issue body, masking the gap).
      if (!plan) {
        const abortReason =
          "Architect produced no plan — the model exhausted its tool-step budget " +
          "without writing one. Raise MAC_AGENT_MAX_STEPS or route the architect " +
          "phase to a stronger model (MAC_MODELS), then retry.";
        logger.warn(`[build] ${ref(st)} architect: ${abortReason}`);
        const aborted = { ...st, plan: "", aborted: true, abortReason };
        await writeArtifact(ws, artifact(st, "architect-plan.md"), "(architect produced no plan)");
        await writeArtifact(ws, artifact(st, "status.md"), statusMd(aborted, "architect"));
        const upd = await publishPhase(aborted, ws, {
          phase: "architect",
          status: "failed",
          detail: "no plan produced",
          commitMessage: `chore(mac): architect produced no plan for #${st.issueNumber}`,
        });
        return { ...aborted, ...upd };
      }

      const result = { ...st, plan };
      logger.info(`[build] ${ref(st)} architect: plan ready (${plan.length} chars)`);

      await writeArtifact(ws, artifact(st, "architect-plan.md"), plan);
      await writeArtifact(ws, artifact(st, "status.md"), statusMd(result, "architect"));

      // Link the committed plan on the Architect row so it's reviewable from the
      // status comment / Slack (the plan is pushed to the branch in this same call).
      const upd = await publishPhase(result, ws, {
        phase: "architect",
        status: "done",
        detail: `[view plan](${artifactUrl(result, "architect-plan.md")})`,
        commitMessage: `docs(mac): architect plan for #${st.issueNumber}`,
      });
      return { ...result, ...upd };
    },
  });

  /** post_architect approval gate — real suspend()/resume(). */
  const approvalStep = createStep({
    id: "post_architect",
    inputSchema: buildState,
    outputSchema: buildState,
    resumeSchema: z.object({
      decision: z.enum(["approve", "reject"]),
      reason: z.string().optional(),
    }),
    suspendSchema: z.object({
      message: z.string(),
      branch: z.string(),
      plan: z.string(),
    }),
    execute: async ({ inputData, resumeData, suspend, mastra }) => {
      const logger = mastra.getLogger();
      const st = inputData;
      if (st.aborted) return st; // guardrails BLOCKED — no plan to approve.

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();

      if (resumeData) {
        const approved = resumeData.decision === "approve";
        logger.info(
          `[build] ${ref(st)} approval: plan ${approved ? "approved — implementing" : "rejected — aborting"}`,
        );
        const result = {
          ...st,
          approved,
          aborted: !approved,
          abortReason: approved ? undefined : resumeData.reason ?? "Architect plan rejected.",
        };
        const upd = await publishPhase(result, ws, {
          phase: "approval",
          status: approved ? "done" : "blocked",
          detail: approved ? "approved" : "rejected",
        });
        return { ...result, ...upd };
      }

      // First pass: mark the gate as awaiting in the status comment, then suspend.
      logger.info(`[build] ${ref(st)} approval: awaiting plan approval (suspended)`);
      await publishPhase(st, ws, {
        phase: "approval",
        status: "awaiting",
        detail: "awaiting approval",
      });
      await suspend({
        message:
          "Architect plan complete — approve to implement, or reject to abort. " +
          "Click the ✅ Approve / ❌ Reject link in the issue status comment " +
          "(or resume via POST /api/workflows/build/resume-async with " +
          '{"step":"post_architect","resumeData":{"decision":"approve"}}).',
        branch: st.branch,
        plan: st.plan,
      });
      // Unreachable after suspend; re-invoked with resumeData on resume.
      return st;
    },
  });

  const executorStep = createStep({
    id: "executor",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      if (st.aborted) return st;

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();
      logger.info(`[build] ${ref(st)} executor: implementing the plan…`);
      st = await markRunning(st, ws, "executor", "implementing the plan…");

      const agent = deps.agents.byId("executor");
      const res = await agent.generate(
        [
          "Implement the architect's plan in this checkout. Edit files and ensure",
          "tests/lint/typecheck pass. Do not run git.",
          "",
          issueContext(st),
          "",
          "ARCHITECT PLAN:",
          st.plan,
        ].join("\n"),
        { requestContext: buildAgentContext(st.taskId, undefined, SKILLS.executor), tracingContext },
      );
      const executorSummary = res.text ?? "";
      const result = { ...st, executorSummary, cycle: 0 };
      logger.info(`[build] ${ref(st)} executor: implementation complete`);

      await writeArtifact(
        ws,
        artifact(st, "executor-summary.md"),
        `# Executor summary\n\n${executorSummary || "(executor produced no summary)"}\n`,
      );
      await writeArtifact(ws, artifact(st, "status.md"), statusMd(result, "executor"));

      const upd = await publishPhase(result, ws, {
        phase: "executor",
        status: "done",
        detail: "implemented",
        commitMessage: `feat(mac): implement #${st.issueNumber}`,
      });
      return { ...result, ...upd };
    },
  });

  /**
   * The review↔fix loop is a NESTED WORKFLOW `[review → executor(fix)]` that the
   * main workflow repeats with `.dountil` (Mastra's `Workflow implements Step`).
   * So a REQUEST_CHANGES genuinely sends the work BACK THROUGH A DISTINCT EXECUTOR
   * STEP — it is not a fix buried inside the reviewer — and each half is its own
   * visible, separately-committed checklist entry.
   *
   * Per iteration: reviewStep judges the current branch diff; fixStep then runs
   * ONLY if the review asked for changes and budget remains (it skips entirely
   * when the review is APPROVE). When the work converges to APPROVE the loop stops
   * right after that review. Only at budget EXHAUSTION does the final fix ship
   * without a re-review — the PR is opened for human review anyway.
   */
  const fixStep = createStep({
    id: "executor_fix",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      // Review was APPROVE / aborted / out of budget → nothing to fix.
      if (st.aborted || st.lastVerdict !== "REQUEST_CHANGES" || st.cycle >= st.maxCycles) {
        return st;
      }

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();
      const cycle = st.cycle + 1;
      logger.info(`[build] ${ref(st)} fix cycle ${cycle}: addressing review feedback…`);
      const fixKey = `fix-${cycle}`;
      st = {
        ...st,
        cycle,
        progress: upsertBefore(st.progress, "pr", {
          key: fixKey,
          label: `Executor — fix (cycle ${cycle})`,
          status: "running",
          detail: "addressing review feedback…",
        }),
      };
      st = { ...st, ...(await publishPhase(st, ws, {})) }; // refresh comment

      const fix = deps.agents.byId("fix");
      const res = await fix.generate(
        [
          `Fix cycle ${cycle}. Address ONLY the reviewer's issues below; keep the`,
          "change aligned with the architect's plan. Re-run tests before finishing.",
          "",
          "ARCHITECT PLAN:",
          st.plan,
          "",
          "REVIEWER FEEDBACK:",
          st.reviewBody,
        ].join("\n"),
        { requestContext: buildAgentContext(st.taskId, undefined, SKILLS.fix), tracingContext },
      );
      await writeArtifact(
        ws,
        artifact(st, `fix-${cycle}.md`),
        `# Fix cycle ${cycle}\n\n${res.text ?? "(no summary)"}\n`,
      );
      st = { ...st, progress: setStatus(st.progress, fixKey, "done", "changes applied") };
      logger.info(`[build] ${ref(st)} fix cycle ${cycle}: changes applied`);
      st = {
        ...st,
        ...(await publishPhase(st, ws, {
          commitMessage: `fix(mac): apply review cycle ${cycle} for #${st.issueNumber}`,
        })),
      };
      return st;
    },
  });

  const reviewStep = createStep({
    id: "review",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, tracingContext, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      if (st.aborted) return st;

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();
      const reviewNum = st.cycle + 1;
      logger.info(`[build] ${ref(st)} review cycle ${reviewNum}: reviewing branch diff…`);
      const reviewKey = `review-${reviewNum}`;
      st = {
        ...st,
        progress: upsertBefore(st.progress, "pr", {
          key: reviewKey,
          label: `Review (cycle ${reviewNum})`,
          status: "running",
          detail: "reviewing…",
        }),
      };
      st = { ...st, ...(await publishPhase(st, ws, {})) }; // refresh comment

      const diff = await workingDiff(ws, st.baseBranch);
      const reviewer = deps.agents.byId("build-reviewer");
      const res = await reviewer.generate(
        [
          "Review this change against the plan.",
          "",
          "ARCHITECT PLAN:",
          st.plan,
          "",
          "BRANCH DIFF (vs base):",
          "```diff",
          diff.slice(0, 80_000),
          "```",
        ].join("\n"),
        { tracingContext },
      );
      const { event, body } = parseVerdict(res.text ?? "");
      const exhausted = event !== "APPROVE" && st.cycle >= st.maxCycles;
      logger.info(
        `[build] ${ref(st)} review cycle ${reviewNum}: ${event}${exhausted ? " (budget exhausted)" : ""}`,
      );
      let result = {
        ...st,
        lastVerdict: event,
        reviewBody: body,
        approved: event === "APPROVE",
        diff,
        progress: setStatus(
          st.progress,
          reviewKey,
          event === "APPROVE" ? "done" : exhausted ? "failed" : "done",
          exhausted ? `${event} (budget exhausted)` : event,
        ),
      };

      await writeArtifact(
        ws,
        artifact(st, "reviewer-verdict.md"),
        `# Reviewer verdict (cycle ${reviewNum})\n\nVerdict: ${event}\n\n${body}\n`,
      );
      await writeArtifact(ws, artifact(st, "status.md"), statusMd(result, `review_cycle_${reviewNum}`));

      result = {
        ...result,
        ...(await publishPhase(result, ws, {
          commitMessage: `chore(mac): review cycle ${reviewNum} for #${st.issueNumber}`,
        })),
      };
      return result;
    },
  });

  /** Loop body: review, then (only if changes were requested) send back to the executor. */
  const reviewCycle = createWorkflow({
    id: "review_cycle",
    inputSchema: buildState,
    outputSchema: buildState,
  })
    .then(reviewStep)
    .then(fixStep)
    .commit();

  const finalizeStep = createStep({
    id: "finalize",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, mastra }) => {
      const logger = mastra.getLogger();
      const st = inputData;

      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();

      if (st.aborted) {
        logger.info(`[build] ${ref(st)} build aborted — ${st.abortReason ?? "unknown reason"}`);
        await writeArtifact(ws, artifact(st, "status.md"), statusMd(st, "aborted"));
        const upd = await publishPhase(st, ws, {
          commitMessage: `chore(mac): aborted #${st.issueNumber}`,
        });
        return { ...st, ...upd };
      }

      const diff = st.diff || (await workingDiff(ws, st.baseBranch));
      const filesChanged = await changedFiles(ws, st.baseBranch);
      const result = { ...st, diff, filesChanged };
      logger.info(
        `[build] ${ref(st)} build complete — verdict ${st.lastVerdict ?? "n/a"}, ${st.cycle} review cycle(s), ${filesChanged.length} file(s) changed`,
      );

      await writeArtifact(
        ws,
        artifact(st, "build-result.md"),
        [
          "# Build result",
          "",
          `- final verdict: ${st.lastVerdict ?? "n/a"}`,
          `- review cycles: ${st.cycle}`,
          `- files changed: ${filesChanged.length ? filesChanged.join(", ") : "(none)"}`,
          "",
          "## Code diff",
          "```diff",
          diff || "(empty)",
          "```",
        ].join("\n"),
      );
      await writeArtifact(ws, artifact(st, "status.md"), statusMd(result, "complete"));

      const upd = await publishPhase(result, ws, {
        commitMessage: `chore(mac): build result for #${st.issueNumber}`,
      });
      return { ...result, ...upd };
    },
  });

  /**
   * PR step (createPr, default true). The branch was already pushed incrementally
   * by each phase, so this opens the PR against baseBranch and links it in the
   * status comment. Skipped when there's no code change or progress isn't being
   * published.
   */
  const prStep = createStep({
    id: "pr",
    inputSchema: buildState,
    outputSchema: buildState,
    execute: async ({ inputData, mastra }) => {
      const logger = mastra.getLogger();
      let st = inputData;
      const ws = deps.workspaceFactory.create(st.taskId);
      await ws.init();

      if (!st.createPr || !st.publishProgress || st.aborted || st.filesChanged.length === 0) {
        const reason = st.aborted
          ? "build aborted"
          : st.filesChanged.length === 0
            ? "no changes"
            : "disabled";
        logger.info(`[build] ${ref(st)} PR skipped — ${reason}`);
        const upd = await publishPhase(st, ws, {
          phase: "pr",
          status: "skipped",
          detail: reason,
        });
        const done = { ...st, ...upd };
        await slackTerminal(done);
        return done;
      }

      logger.info(`[build] ${ref(st)} PR: opening pull request…`);
      st = await markRunning(st, ws, "pr", "opening pull request…");
      const token = await mintWriteToken();
      const octokit = fns.createOctokit({ token });
      const body = [
        `Closes #${st.issueNumber}`,
        "",
        "## Summary",
        st.executorSummary ? st.executorSummary.slice(0, 4000) : "(see executor-summary.md)",
        "",
        "## Review",
        `Final verdict: **${st.lastVerdict ?? "n/a"}** after ${st.cycle} fix cycle(s).`,
        st.lastVerdict === "REQUEST_CHANGES"
          ? `\n> ⚠️ Unresolved reviewer issues remain — see \`.mac/${st.issueDir}/reviewer-verdict.md\`.`
          : "",
        "",
        `## Planning & execution artifacts (on this branch, \`.mac/${st.issueDir}/\`)`,
        "- guardrails-report.md",
        "- architect-plan.md",
        "- executor-summary.md",
        "- reviewer-verdict.md",
        "- build-result.md",
        "- status.md",
      ].join("\n");

      let result = st;
      try {
        const { data } = await octokit.rest.pulls.create({
          owner: st.owner,
          repo: st.repo,
          base: st.baseBranch,
          head: st.branch,
          title: `${st.issueTitle} (#${st.issueNumber})`,
          body,
        });
        result = { ...st, prUrl: data.html_url, prNumber: data.number };
        logger.info(`[build] ${ref(st)} PR opened — #${data.number} ${data.html_url}`);
      } catch (e) {
        logger.warn(`[build] ${ref(st)} PR creation failed: ${(e as Error).message}`);
      }

      await writeArtifact(ws, artifact(st, "status.md"), statusMd(result, "pr_created"));
      const upd = await publishPhase(result, ws, {
        phase: "pr",
        status: result.prUrl ? "done" : "failed",
        detail: result.prUrl ? `#${result.prNumber}` : "PR creation failed",
        commitMessage: `chore(mac): PR for #${st.issueNumber}`,
        reaction: result.prUrl ? "hooray" : undefined,
      });
      const done = { ...result, ...upd };
      await slackTerminal(done);
      return done;
    },
  });

  // ── Workflow ─────────────────────────────────────────────────────────────────

  return createWorkflow({
    id: "build",
    inputSchema: triggerSchema,
    outputSchema: buildState,
  })
    .then(setupStep)
    .then(guardrailsStep)
    .then(architectStep)
    .then(approvalStep)
    .then(executorStep)
    .dountil(reviewCycle, async ({ inputData, iterationCount }) => {
      const st = inputData as BuildState;
      return (
        st.aborted ||
        st.approved ||
        st.cycle >= st.maxCycles ||
        iterationCount >= st.maxCycles + 2
      );
    })
    .then(finalizeStep)
    .then(prStep)
    .commit();
}

/**
 * The built-in `build` workflow definition. The host resolves its `requires`
 * keys (GitHub + the agent registry) before `create()` runs, auto-enables the
 * build agents transitively, and the optional Slack capability degrades to "no
 * Slack post" when no Slack platform is configured. The app supplies the
 * `workspaceFactory` (per-run checkout) and `approvalLinks` (signed HMAC links)
 * via the host config.
 */
/** Shape build input from a classifier context (GitHub issue-comment build, or Slack "build repo#n"). */
function buildInput(ctx: RouteContext): Record<string, unknown> {
  const parts = splitRepo(ctx.envelope.repo ?? ctx.classification?.repo);
  const issueNumber = ctx.envelope.issueNumber ?? ctx.classification?.issueNumber;
  return {
    owner: parts?.owner ?? "",
    repo: parts?.repo ?? "",
    issueNumber,
    issueTitle: ctx.envelope.title ?? "",
    // The comment/message body seeds the issue body; the build agents fetch the
    // live issue via tools anyway. Flag it if the screener was suspicious.
    issueBody: applyInjectionFlag(ctx.envelope.body ?? "", ctx.classification),
    baseBranch: "main",
    ...slackOriginFromEnvelope(ctx.envelope),
  };
}

export const buildWorkflowDefinition: MacWorkflowDefinition = defineWorkflow({
  id: "build",
  description:
    "Implement a GitHub issue end-to-end: guardrails, plan (human-approved), execute, review/fix loop, open a PR.",
  requires: [githubCapabilities, agentCapabilities],
  optional: [slackCapabilities],
  requiredAgents: ["guardrails", "architect", "executor", "fix", "build-reviewer"],
  // Classifier intent: a maintainer's "build" on a GitHub issue (repo+issue from
  // the envelope) or a Slack "build acme/widgets#42" (repo+issue from the text).
  // Managed-repo gated; GitHub maintainer-gating is enforced by the comment guard.
  classifierIntents: [
    {
      id: "BUILD",
      description:
        "Implement code changes NOW in a GitHub repo: a feature, a bug fix, or resolving an issue with a PR. Requires a GitHub target — a repo reference in the message, or a reply on an existing issue.",
      examples: [
        "build acme/widgets#42",
        "implement this",
        "lets build this!",
        "fix the failing test in cliftonc/lastlight#7",
      ],
      requires: { repo: true, managedRepo: true, issueNumber: true },
      target: { type: "workflow", id: "build", input: buildInput },
    },
  ],
  create: ({ capabilities, workspaceFactory, approvalLinks }) => {
    const github = capabilities.require(githubCapabilities);
    const agents = capabilities.require(agentCapabilities);
    const slack = capabilities.optional(slackCapabilities);
    if (!workspaceFactory) throw new Error("build workflow requires a workspaceFactory");
    if (!approvalLinks) throw new Error("build workflow requires approvalLinks (host config)");
    return createBuildWorkflow({
      github,
      agents,
      workspaceFactory,
      approvalLinks,
      slack: slack?.functions,
    });
  },
});
