# Last Light → Mastra migration log

This repo re-implements [`lastlight`](../lastlight) (a GitHub repo-maintenance agent) as an
idiomatic [Mastra](https://mastra.ai) v1 app. We copy code/config from lastlight as needed,
keep things as close to vanilla Mastra as possible, and **drop misfits with a note here**.

Source of truth for lastlight's behavior: `../lastlight/spec/` and `../lastlight/CLAUDE.md`.

## Status

- **M1 — Scaffold (done):** pnpm + turbo monorepo; `apps/maintenance` is the deployable
  Mastra unit. `pnpm -C apps/maintenance build` (= `mastra build`) produces a Hono server in
  `.mastra/output/`. Typecheck clean. Assets (prompts, skills, agent-context, `.env`) copied
  from lastlight.
- M2–M7: see `../../.claude/plans/ok-we-have-a-splendid-fairy.md`.

## Pinned Mastra API signatures (verified against installed packages, not docs)

Installed: `@mastra/core` **1.37.1**, `@mastra/libsql` 1.11.1, `@mastra/loggers` 1.1.1,
`@mastra/memory` 1.20.0, `mastra` (CLI) 1.10.2, `ai` 6.x, `@ai-sdk/anthropic` 3.x.

- **Entry:** `new Mastra({ storage, logger, agents, workflows, /* server, observability */ })`
  from `@mastra/core`.
- **Server routes:** `registerApiRoute(path, options)` from `@mastra/core/server` —
  **path is the FIRST positional arg**, not a field in options. Options:
  `{ method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'ALL', handler, middleware?, openapi?, requestContext? }`.
  `handler` is a Hono `Handler` (receives Hono `Context`). Wire via `server: { apiRoutes: [...] }`
  on the `Mastra` constructor. (The plan's earlier `registerApiRoute({ path, ... })` form is wrong.)
- **Workflows:** `createWorkflow` / `createStep` from `@mastra/core/workflows`. Chaining
  confirmed present (`.then`, etc.); exact loop/branch method names to be pinned in M3/M4.
- **Tools:** `createTool` from `@mastra/core/tools`.
- **Agent:** `Agent` from `@mastra/core/agent`.
- **Storage:** `LibSQLStore` from `@mastra/libsql` (`new LibSQLStore({ url: 'file:./data/mastra.db' })`).
- **Logger:** `PinoLogger` from `@mastra/loggers`.
- Notable subpaths in `@mastra/core`: `./agent`, `./agent/durable`, `./workflows`,
  `./workflows/evented`, `./tools`, `./memory`, `./server`, `./tool-loop-agent`.

### Peer-dep note
`@mastra/core` pulls AI-SDK v4 utils that peer-depend on `zod@^3`, but we use `zod@4`.
Install warns; build/typecheck pass. Revisit if zod-schema tools misbehave at runtime.

## Gotchas hit during M1 (and fixes)

- **`pnpm: command not found`** — pnpm isn't globally installed; this machine uses nvm.
  `mastra build`'s deploy step shells out to `pnpm install`, so pnpm must be on PATH.
  Fix: `corepack enable` (installs a `pnpm` shim into the active nvm node `bin/`). Use
  `corepack pnpm …` if you skip that.
- **libsql "error 14" (`Unable to open ./data/mastra.db`)** — LibSQL creates the file but
  **not** the parent dir, and `mastra dev`/`build` run from `.mastra/output`, so a relative
  `./data/...` resolves to a missing dir. Fix: entry resolves an **absolute** db path from
  `LASTLIGHT_DB_URL` / `LASTLIGHT_STATE_DIR` (set to an absolute `data/` in `.env`).
- **`timeout` not on macOS** — use Bash `run_in_background` + a `Monitor`/until-loop probe
  instead of `timeout`/chained `sleep`.
- **`mastra dev|build` need `-d src/mastra`** — entry isn't at the default path; the app
  scripts pass `-d src/mastra`.
- **`createTool` execute signature** — `(inputData, context) =>`, input is the FIRST arg
  (not `{ context }` destructuring). The plan's earlier `{ context }` form was wrong.
- **`new Agent` requires `id`** — not just `name`.
- **Workspace/Sandbox live in `@mastra/core/workspace`** — `Workspace`, `LocalFilesystem`,
  `LocalSandbox` are exported from that subpath (NOT the main `@mastra/core` entry, and the
  `@mastra/workspace-*` packages aren't published at this version). `Agent({ workspace })`
  auto-adds `execute_command`+file tools. `createStep`/`createWorkflow` from
  `@mastra/core/workflows`; `execute: async ({ inputData }) => ...`; build with
  `createWorkflow({id,inputSchema,outputSchema}).then(step).commit()`.
- **Eager secret reads crash boot** — the chat agent built the Octokit (which reads the PEM)
  at module load, so a missing/relative PEM took down the whole server. Fixed by (a) wrapping
  GitHub-tool init in try/catch (boot never fails on an optional secret), and (b) copying the
  PEM to an absolute `secrets/app.pem` and pointing `GITHUB_APP_PRIVATE_KEY_PATH` at it.
  `secrets/` is gitignored.
- **Turbo `WARNING IO error: No such file or directory (os error 2)`** — emitted by Turbo's
  cache writer; cosmetic, the build still succeeds. We **removed Turbo entirely** (it's a
  monorepo task runner, not a bundler — unrelated to vite/turbopack). Root `package.json`
  scripts now delegate directly: `pnpm -C apps/maintenance <script>`. Mastra owns its own
  server bundler (Rollup/esbuild) and ships a prebuilt Studio UI, so vite is not involved.

Verified green: `pnpm -C apps/maintenance build` → `.mastra/output/index.mjs`;
`node --env-file=.env .mastra/output/index.mjs` boots ("Mastra API running at
http://localhost:4111/api"); `/api/agents` and `/api/workflows` return `{}`.

## Component mapping (lastlight → here)

| Lastlight | Here | State |
|---|---|---|
| `pi-ai` chat | Mastra `Agent` + `Memory` (LibSQL) | M2 |
| `agentic-pi`/gondolin coding agent | `mastracode` (npm) / our `Agent` over a Mastra Workspace sandbox | M3 |
| YAML runner (linear/DAG/loops/gates) | `createWorkflow`/`createStep` + `suspend()`/`resume()` | M3/M4 |
| router/classifier/screener | ported into `apps/maintenance/src/mastra/` | M5 |
| `git-auth.ts`/`profiles.ts` + `mcp-github-app` | `packages/github` (octokit + token mint) | M3/M5 |
| Hono server + admin + webhook | Mastra `server.apiRoutes` (`registerApiRoute`) | M5 |
| Slack Socket Mode (`@slack/bolt`) | Bolt service beside the Mastra server | M5 |
| Cron (`croner`) | native workflow `schedule` + repo fan-out | M6 |
| StateDb / JSONL shim / dashboard | Mastra storage + AI tracing in Studio | ongoing |
| config overlay + `default.yaml` | `.env` + a single config file | ongoing |

## Dropped / deferred (with reasons)

- **Network egress firewall** (gondolin `allowedHttpHosts`; docker SNI-peek + coredns
  sinkhole; SSRF floor) — **deferred** per spike scope. Sandbox runs with provider defaults
  for now; re-add before any production use.
- **gondolin QEMU sandbox + docker firewall sidecars** — replaced by `mastracode`/Mastra
  Workspace sandbox (no `/dev/kvm` dependency).
- **JSONL envelope shim + `SessionReader`** — replaced by Mastra built-in AI tracing (Studio).
- **Custom React/Vite admin dashboard** — Mastra Studio (`mastra dev`) for now; revisit.
- **DAG runner, restart-count circuit breaker, daily/hourly stat rollups** — port only if a
  workflow needs them.
- **Config overlay/instance layering** — simplified to `.env` + one config file.
- **`code.mastra.ai` hosted app / `mastra-ai/code` repo** — the latter is private/non-existent;
  we use the published `mastracode` package + `@mastra/*` from npm instead.

## Env (copied from lastlight `.env`)

`apps/maintenance/.env` carries: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`
(`./secrets/app.pem`), `WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`,
`OPENCODE_MODEL` (`anthropic/claude-sonnet-4-6`), `OPENCODE_MODELS`, `LASTLIGHT_SANDBOX`.
The PEM itself is **not** copied yet (add `secrets/app.pem` when wiring GitHub in M3/M5).
Legacy `OPENCODE_*` names are kept as-is for now; may rename to `LASTLIGHT_*` later.
