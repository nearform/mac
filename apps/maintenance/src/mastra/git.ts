import type { Workspace } from "@mastra/core/workspace";
import { createCodeWorkspace } from "./workspace.js";

/**
 * Deterministic git plumbing for the build workflow, run through the Mastra
 * Workspace sandbox (`ws.sandbox.executeCommand`). The WORKFLOW owns version
 * control — clone, branch, diff — mirroring the M3 lesson that the workflow
 * acts deterministically while the agent only produces content. The build
 * agents (architect/executor/fix) never run git themselves; they edit files
 * and run tests inside the checkout via their own workspace tools.
 *
 * GITHUB-CENTRIC (M4 reversal): the workflow DOES push. Each phase commits its
 * work and pushes a per-RUN branch `lastlight/issue-<n>-<runId>` — a fresh ref
 * each build, so it starts from clean base with no prior run's `.lastlight/`
 * state and its per-phase pushes can't collide (plain, non-force). Git stays
 * deterministic and workflow-owned — agents only
 * produce content, never run git. Every git op re-adds a short-lived token to
 * the remote URL only for the network call and strips it immediately after, so
 * no credential is persisted on disk. Clone/branch use a READ token; push/PR use
 * a WRITE token minted per-step. See ../../../MIGRATION.md.
 */

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Recreate the workspace for a taskId (same on-disk checkout dir across steps). */
export function taskWorkspace(taskId: string): Workspace {
  return createCodeWorkspace(taskId);
}

/** Run a command in the workspace sandbox; throws on non-zero unless `allowFail`. */
export async function runInWorkspace(
  ws: Workspace,
  command: string,
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<GitResult> {
  const sandbox = ws.sandbox;
  if (!sandbox?.executeCommand) {
    throw new Error("Workspace sandbox has no executeCommand — cannot run git.");
  }
  const res = await sandbox.executeCommand(command, args);
  const result: GitResult = {
    exitCode: res.exitCode,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
  if (!opts.allowFail && res.exitCode !== 0) {
    throw new Error(
      `\`${command} ${args.join(" ")}\` failed (${res.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/**
 * True if THIS checkout dir already has its own `.git` (resume-safe clone guard).
 *
 * We check `--git-dir` resolves to the local `.git`, NOT
 * `--is-inside-work-tree`: the workspaces root can itself live inside an
 * ancestor git repo (lastlight-mastra is a repo), and `--is-inside-work-tree`
 * walks UP and would falsely report an empty checkout as already cloned. When
 * run from a freshly-cloned dir, `--git-dir` returns the relative `.git`; from
 * an empty dir inside an ancestor repo it returns that ancestor's absolute path.
 */
export async function isCloned(ws: Workspace): Promise<boolean> {
  const res = await runInWorkspace(ws, "git", ["rev-parse", "--git-dir"], {
    allowFail: true,
  });
  return res.exitCode === 0 && res.stdout.trim() === ".git";
}

/**
 * Clone `owner/repo` into the workspace root using a short-lived token, then
 * strip the token from the remote URL so nothing credential-bearing is left on
 * disk. Idempotent: if already cloned, fetches + resets to the base branch.
 */
export async function cloneRepo(
  ws: Workspace,
  args: { owner: string; repo: string; token: string; baseBranch: string },
): Promise<void> {
  const { owner, repo, token, baseBranch } = args;
  const tokenUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const cleanUrl = `https://github.com/${owner}/${repo}.git`;

  // Clear stale git locks left by an interrupted run (e.g. the server was killed
  // mid-clone) so a re-run on the same checkout dir doesn't choke on index.lock.
  await runInWorkspace(
    ws,
    "rm",
    ["-f", ".git/index.lock", ".git/HEAD.lock", ".git/config.lock"],
    { allowFail: true },
  );

  if (await isCloned(ws)) {
    // Resume path: re-auth, fetch fresh, reset to the base branch.
    await runInWorkspace(ws, "git", ["remote", "set-url", "origin", tokenUrl]);
    await runInWorkspace(ws, "git", ["fetch", "origin", baseBranch]);
    await runInWorkspace(ws, "git", ["checkout", baseBranch]);
    await runInWorkspace(ws, "git", ["reset", "--hard", `origin/${baseBranch}`]);
  } else {
    // `clone . ` requires an empty dir; the workspace root is fresh per taskId.
    await runInWorkspace(ws, "git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      baseBranch,
      tokenUrl,
      ".",
    ]);
  }

  // Drop the credential from the persisted remote, and set a local identity so
  // the executor's in-checkout work (e.g. test scaffolding) has a valid author
  // if anything stages a commit — though the workflow itself never commits.
  await runInWorkspace(ws, "git", ["remote", "set-url", "origin", cleanUrl]);
  await runInWorkspace(ws, "git", ["config", "user.email", "last-light@users.noreply.github.com"]);
  await runInWorkspace(ws, "git", ["config", "user.name", "last-light"]);
}

/**
 * Create the working branch fresh off the cloned base HEAD.
 *
 * The branch is per-RUN (`lastlight/issue-<n>-<runId>` — see build.ts), so it's
 * always a NEW ref: every build starts from a clean base with no prior run's
 * `.lastlight/` state (guardrails report, plan, etc.) on it. That clean start is
 * the whole point — continuing an existing branch would resurrect stale
 * per-phase artifacts and confuse the agents. A fresh ref also means the
 * per-phase push is a plain (non-force) push that can't collide.
 */
export async function createBranch(ws: Workspace, branch: string): Promise<void> {
  await runInWorkspace(ws, "git", ["checkout", "-B", branch]);
}

export interface InstallResult {
  /** Whether an install was attempted (false for non-Node repos). */
  ran: boolean;
  /** Whether it succeeded (exit 0). */
  ok: boolean;
  /** Detected package manager, or "none". */
  packageManager: string;
  /** Tail of the install command + combined stdout/stderr (for the artifact). */
  output: string;
}

/**
 * Deterministic dependency install — workflow-owned, like git. The guardrails
 * agent was *told* to "install deps if needed", but that's LLM-discretionary and
 * it sometimes SKIPPED it, leaving the test runner not on disk and producing a
 * false BLOCK (`sh: vitest: command not found`). Installing here guarantees the
 * runner exists for guardrails AND the later executor/review phases (they share
 * the same checkout dir under the run's taskId).
 *
 * Node-only: the package manager is detected from the lockfile. Non-Node repos
 * (cargo/go/pytest) are a no-op — their runners resolve/compile on demand and the
 * guardrails agent handles them. `npm install` (not `npm ci`) is used so a repo
 * whose lockfile is slightly out of sync with package.json still installs.
 * Best-effort: returns the outcome; a hard failure surfaces in the guardrails
 * report (the agent will find no working runner and BLOCK — correct).
 */
export async function installDependencies(ws: Workspace): Promise<InstallResult> {
  const detect = await runInWorkspace(
    ws,
    "sh",
    [
      "-c",
      "if [ -f pnpm-lock.yaml ]; then echo pnpm; " +
        "elif [ -f yarn.lock ]; then echo yarn; " +
        "elif [ -f bun.lockb ]; then echo bun; " +
        "elif [ -f package-lock.json ] || [ -f package.json ]; then echo npm; " +
        "else echo none; fi",
    ],
    { allowFail: true },
  );
  const pm = detect.stdout.trim();
  if (!pm || pm === "none") {
    return { ran: false, ok: true, packageManager: "none", output: "no Node manifest — skipping install" };
  }

  const cmd =
    pm === "pnpm"
      ? "pnpm install"
      : pm === "yarn"
        ? "yarn install"
        : pm === "bun"
          ? "bun install"
          : "npm install --no-audit --no-fund";

  const res = await runInWorkspace(ws, "sh", ["-c", cmd], { allowFail: true });
  return {
    ran: true,
    ok: res.exitCode === 0,
    packageManager: pm,
    output: `$ ${cmd}\n${res.stdout}${res.stderr}`.slice(-4000),
  };
}

/**
 * Pathspec for code diffs: exclude our own `.lastlight/` artifacts AND dependency
 * lockfiles. The workflow runs `npm install` (guardrails/executor), which churns
 * `package-lock.json`; without this the reviewer flags that churn as a change
 * "outside the plan" every cycle — an unfixable complaint that stalls the loop.
 */
const EXCLUDE_ARTIFACTS = [
  ".",
  ":(exclude).lastlight/**",
  ":(glob,exclude)**/package-lock.json",
  ":(glob,exclude)**/pnpm-lock.yaml",
  ":(glob,exclude)**/yarn.lock",
];

/**
 * Cumulative code diff of the branch vs its base — `git diff origin/<base>`.
 *
 * In GitHub-centric mode each phase COMMITS its work, so a working-tree diff
 * (vs HEAD) would be empty after a commit. Diffing against `origin/<base>`
 * captures the full change whether it's committed or still in the working tree:
 * we `git add -A` first so even brand-new files show up, and exclude the
 * workflow's own `.lastlight/` artifacts so the reviewer sees only real code.
 */
export async function workingDiff(ws: Workspace, baseBranch: string): Promise<string> {
  await runInWorkspace(ws, "git", ["add", "-A"], { allowFail: true });
  const res = await runInWorkspace(
    ws,
    "git",
    ["--no-pager", "diff", "--no-color", `origin/${baseBranch}`, "--", ...EXCLUDE_ARTIFACTS],
    { allowFail: true },
  );
  return res.stdout;
}

/** Names of code files changed vs the base branch (excludes `.lastlight/`). */
export async function changedFiles(ws: Workspace, baseBranch: string): Promise<string[]> {
  await runInWorkspace(ws, "git", ["add", "-A"], { allowFail: true });
  const res = await runInWorkspace(
    ws,
    "git",
    ["--no-pager", "diff", "--name-only", `origin/${baseBranch}`, "--", ...EXCLUDE_ARTIFACTS],
    { allowFail: true },
  );
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Write a build artifact into the checkout's `.lastlight/` dir — the workflow's
 * faithful port of lastlight's per-phase markdown (guardrails-report.md,
 * architect-plan.md, executor-summary.md, reviewer-verdict.md, status.md).
 * Written deterministically from each step's captured agent output (not by the
 * agent), so an artifact never goes missing. Excluded from the reviewed diff;
 * surfaced by finalize and available to push if live-PR mode is enabled.
 */
export async function writeArtifact(
  ws: Workspace,
  relPath: string,
  content: string,
): Promise<void> {
  const fs = ws.filesystem;
  if (!fs) throw new Error("Workspace has no filesystem — cannot write artifact.");
  await fs.writeFile(`.lastlight/${relPath}`, content, {
    recursive: true,
    overwrite: true,
  });
}

/**
 * Live-PR mode only: stage everything (code + `.lastlight/` artifacts) and
 * commit on the work branch as the bot identity. Returns the new commit SHA, or
 * null if there was nothing to commit.
 */
export async function commitAll(ws: Workspace, message: string): Promise<string | null> {
  await runInWorkspace(ws, "git", ["add", "-A"]);
  const status = await runInWorkspace(ws, "git", ["status", "--porcelain"], { allowFail: true });
  if (!status.stdout.trim()) return null;
  await runInWorkspace(ws, "git", ["commit", "-m", message]);
  const sha = await runInWorkspace(ws, "git", ["rev-parse", "HEAD"], { allowFail: true });
  return sha.stdout.trim() || null;
}

/**
 * Live-PR mode only: push the work branch using a short-lived write token in the
 * remote URL, then strip the credential back out so nothing token-bearing is
 * left on disk. THE ONLY function in this module that writes to the remote — it
 * runs solely from the PR step, behind the `createPr` opt-in.
 */
export async function pushBranch(
  ws: Workspace,
  args: { owner: string; repo: string; token: string; branch: string },
): Promise<void> {
  const { owner, repo, token, branch } = args;
  const tokenUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const cleanUrl = `https://github.com/${owner}/${repo}.git`;
  await runInWorkspace(ws, "git", ["remote", "set-url", "origin", tokenUrl]);
  try {
    // Plain push — no --force. createBranch() checked out the existing remote
    // branch (when present) as the local base, so per-phase pushes fast-forward.
    // A fresh branch is a new ref; either way GitHub accepts it without a force.
    await runInWorkspace(ws, "git", ["push", "-u", "origin", branch]);
  } finally {
    await runInWorkspace(ws, "git", ["remote", "set-url", "origin", cleanUrl]);
  }
}

/**
 * Per-phase publish: stage + commit everything (code + `.lastlight/` artifacts)
 * and push the issue branch. The first call creates the branch on GitHub; later
 * calls update it, so progress is visible on the branch as the build runs.
 * Returns the new commit SHA, or null if there was nothing to commit.
 */
export async function commitAndPush(
  ws: Workspace,
  args: { owner: string; repo: string; token: string; branch: string; message: string },
): Promise<string | null> {
  const sha = await commitAll(ws, args.message);
  if (!sha) return null;
  await pushBranch(ws, args);
  return sha;
}
