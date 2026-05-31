# Last Light → Mastra migration log

This repo re-implements [`lastlight`](../lastlight) (a GitHub repo-maintenance agent) as an
idiomatic [Mastra](https://mastra.ai) v1 app. We copy code/config from lastlight as needed,
keep things as close to vanilla Mastra as possible, and **drop misfits with a note here**.

Source of truth for lastlight's behavior: `../lastlight/spec/` and `../lastlight/CLAUDE.md`.

## Status

- **M1 — Scaffold (DONE):** pnpm monorepo (Turbo removed — see gotchas); `apps/maintenance`
  is the deployable Mastra unit. `pnpm -C apps/maintenance build` (= `mastra build -d src/mastra`)
  produces a Hono server in `.mastra/output/`; `node --env-file=.env .mastra/output/index.mjs`
  boots ("Mastra API running at http://localhost:4111/api"). Assets (prompts, skills,
  agent-context, `.env`, PEM) copied from lastlight.
- **M2 — Chat agent (DONE, verified live):** `src/mastra/agents/chat.ts` — Mastra `Agent`
  with persona from `agent-context/*.md`, LibSQL `Memory` (thread per conversation), and the
  read-only GitHub tools from `packages/github`. Verified: asked it to look up
  `cliftonc/lastlight#1`, it called `github_get_issue` (via the minted GitHub-App token) and
  returned the real title/state. Provider OpenAI (`gpt-5.1`).
- **M3 — pr-review workflow + real sandbox (DONE, verified live):** posted a real review to
  `cliftonc/lastlight#69` (`last-light-bot[bot]`, COMMENTED). Details below.
- **M4 — build workflow:** in progress.
- **M5–M7:** see `../../.claude/plans/ok-we-have-a-splendid-fairy.md`.

## Packages

- **`apps/maintenance`** — the deployable Mastra app. `src/mastra/index.ts` builds the
  `Mastra` instance (storage, logger, agents, workflows). `config.ts` (env-based config),
  `memory.ts` (LibSQL Memory), `agent-context.ts` (persona loader), `workspace.ts`
  (LocalFilesystem+LocalSandbox), `agents/` (chat, reviewer, sandbox-probe), `workflows/`
  (pr-review).
- **`packages/github`** — ported from lastlight, framework-agnostic + Mastra tools:
  - `profiles.ts` — `GitAccessProfile`, `GITHUB_PERMISSION_PROFILES`, `resolveProfile` (verbatim).
  - `auth.ts` — `mintInstallationToken` / `mintTokenForProfile` (RS256 app JWT → installation
    token, per-profile downscoping). **Dropped** lastlight's `~/.gitconfig` credential-helper
    writing — the sandbox gets the token via env.
  - `client.ts` — `createInstallationOctokit` / `createTokenOctokit`.
  - `tools.ts` — read-only Mastra tools: `github_read_file`, `github_get_issue`,
    `github_list_issue_comments`, `github_search_issues`, `github_get_pull_request_diff`.
  - `write-tools.ts` — `postPullRequestReview()` (+ `github_post_review` tool) with a COMMENT
    fallback when APPROVE/REQUEST_CHANGES is rejected on the bot's own PR.

## M3 detail (pr-review)

- Real Mastra `Workspace` via `@mastra/core/workspace` (`LocalFilesystem` + `LocalSandbox`)
  in `workspace.ts`. Verified the sandbox runs shell: a probe agent ran `echo … && pwd` via
  `mastra_workspace_execute_command`.
- `agents/reviewer.ts` — read-only review agent (diff + file tools + sandbox). It does NOT
  post; it emits a `VERDICT: APPROVE|REQUEST_CHANGES|COMMENT` marker + markdown body
  (`parseVerdict`).
- `workflows/pr-review.ts` — `createWorkflow({id,inputSchema,outputSchema}).then(review).commit()`.
  The step mints a `review-write` token, runs the agent, then **posts the review
  deterministically** from the workflow via `postPullRequestReview()` — not via the agent's
  tool loop.
- **Two bugs the live test caught & fixed:**
  1. *Agent non-determinism* — the agent sometimes narrated a review instead of calling the
     post tool, so nothing posted. Fix: verdict-marker + workflow-posts split (mirrors
     lastlight's reviewer-emits-verdict / orchestrator-acts design).
  2. *Self-approval* — GitHub rejects APPROVE/REQUEST_CHANGES on the bot's own PR. Fallback
     to a COMMENT review.

## Pinned Mastra API signatures (verified against installed packages, not docs)

Installed: `@mastra/core` **1.37.1**, `@mastra/libsql` 1.11.1, `@mastra/loggers` 1.1.1,
`@mastra/memory` 1.20.0, `mastra` (CLI) 1.10.2, `ai` 6.x, `@ai-sdk/openai` 3.x, `zod` 4.x.

- **Entry:** `new Mastra({ storage, logger, agents, workflows, /* server, observability */ })`
  from `@mastra/core`.
- **Agent:** `new Agent({ id, name, instructions, model, tools?, memory?, workspace? })` from
  `@mastra/core/agent`. **`id` is required.** `model` is a router string (e.g. `'openai/gpt-4o'`).
  Passing `workspace` auto-adds `mastra_workspace_execute_command` + file tools.
- **Tools:** `createTool({ id, description, inputSchema, outputSchema, execute })` from
  `@mastra/core/tools`. **`execute` is `(inputData, context) =>`** — input is the FIRST arg
  (not `{ context }`).
- **Workflows:** `createWorkflow({ id, inputSchema, outputSchema })` + `createStep({ id,
  inputSchema, outputSchema, execute })` from `@mastra/core/workflows`. Build with
  `.then(step).commit()`. Step `execute` is `async ({ inputData }) => ...`.
  REST: `POST /api/workflows/:id/create-run` → `{runId}`, then
  `POST /api/workflows/:id/start-async?runId=<id>` with body `{"inputData":{…}}` (runId is a
  QUERY param; `start` is fire-and-forget, `start-async` returns the finished result).
  Loop/branch/suspend method names to pin in M4.
- **Workspace/Sandbox:** `Workspace`, `LocalFilesystem`, `LocalSandbox` from
  `@mastra/core/workspace` (NOT the main entry; the `@mastra/workspace-*` packages aren't
  published at this version). `LocalSandbox({ workingDirectory, env, timeout })`,
  `LocalFilesystem({ basePath })`.
- **Server routes:** `registerApiRoute(path, options)` from `@mastra/core/server` — path is
  the FIRST positional arg; options `{ method, handler, middleware?, requiresAuth?, openapi? }`,
  `handler` is a Hono `Handler`. (For M5.)
- **Storage:** `new LibSQLStore({ id, url })` from `@mastra/libsql`. **`id` is required.**
- **Logger:** `PinoLogger` from `@mastra/loggers`.

### Peer-dep note
`@mastra/core` pulls AI-SDK utils that peer-depend on `zod@^3`, but we use `zod@4`. Install
warns; build/typecheck/runtime pass so far. Revisit if zod-schema tools misbehave.

## Gotchas hit (and fixes)

- **`pnpm: command not found`** — pnpm isn't global; this machine uses nvm. `mastra build`'s
  deploy step shells out to `pnpm install`, so pnpm must be on PATH. Fix: `corepack enable`.
- **libsql "error 14"** — LibSQL creates the file but not the parent dir, and `mastra
  dev`/`build` run from `.mastra/output`, so a relative `./data/...` misses. Fix: resolve an
  ABSOLUTE db path from `LASTLIGHT_DB_URL`/`LASTLIGHT_STATE_DIR` (set in `.env`).
- **Turbo `WARNING IO error: No such file or directory`** — cosmetic cache-write warning;
  build still succeeds. Removed Turbo entirely (it's a task runner, not a bundler — unrelated
  to vite/turbopack); root scripts delegate via `pnpm -C apps/maintenance <script>`.
- **`mastra dev|build` need `-d src/mastra`** — entry isn't at the default path.
- **`dev` from repo root** — must run from `apps/maintenance` (`pnpm -C apps/maintenance dev`).
- **Eager secret reads crash boot** — building the Octokit (reads the PEM) at module load
  took down the server when the PEM path was relative/missing. Fix: wrap GitHub-tool init in
  try/catch (boot never fails on an optional secret) + copy PEM to absolute `secrets/app.pem`.
- **macOS has no `timeout`** — use background tasks + a polling loop instead.

## Dropped / deferred (with reasons)

- **Network egress firewall** (gondolin `allowedHttpHosts`; docker SNI-peek + coredns
  sinkhole; SSRF floor) — **deferred** per spike scope. `LocalSandbox` runs on the host with
  no isolation/egress firewall. Re-add (or swap to a remote sandbox) before production.
- **gondolin QEMU sandbox + docker firewall sidecars** — replaced by Mastra `LocalSandbox`
  (no `/dev/kvm` dependency); a remote `ComputeSDKSandbox` (E2B/Daytona) is the prod path.
- **JSONL envelope shim + `SessionReader`** — replaced by Mastra built-in AI tracing (Studio).
- **Custom React/Vite admin dashboard** — Mastra Studio (`mastra dev`) for now.
- **DAG runner, restart-count circuit breaker, daily/hourly stat rollups** — port only if a
  workflow needs them.
- **Config overlay/instance layering** — simplified to `.env` + a single config file.
- **`code.mastra.ai` / `mastra-ai/code` repo** — repo is private/non-existent; we use the
  published `mastracode` + `@mastra/*` from npm. (mastracode not yet wired; pr-review uses our
  own Agent over a Mastra Workspace.)

## Env (from lastlight `.env`)

`apps/maintenance/.env` carries the GitHub App config (`GITHUB_APP_ID`,
`GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`), `WEBHOOK_SECRET`, Slack tokens,
`OPENAI_API_KEY` (active provider), and `LASTLIGHT_STATE_DIR` (absolute). The GitHub App PEM
is at `secrets/app.pem` (gitignored). `LASTLIGHT_MODEL` overrides the default model
(`openai/gpt-4o`). Legacy `OPENCODE_*`/`LASTLIGHT_MODEL` names from lastlight are tolerated.
