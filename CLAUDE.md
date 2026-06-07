# CLAUDE.md

MAC (Mastra Agentic Coding) — a GitHub repo-maintenance agent built on Mastra. The
deployable app is `apps/server`; reusable building blocks are the `@nearform/mac*`
packages (`packages/*`). See `README.md` for the full tour, `MIGRATION.md` for the
mapping/pinned-API log, and `docs/` for design notes.

## Commands

```bash
pnpm install            # one-time
pnpm dev                # server (:4111) + Studio (:3000)
pnpm -r typecheck       # all packages
pnpm test               # vitest
pnpm cli <owner/repo#N> # trigger a run against the running server
```

## Conventions

- TypeScript ESM throughout; internal imports use `.js` extensions on `.ts` sources
  (packages are source-only, bundled via `transpilePackages`).
- `@nearform/mac/core` is the dependency sink — it never imports a platform SDK or
  app code (asserted by `packages/mac/test/dependency-graph.test.ts`).
- Local state (sqlite/duckdb/`workspaces/`) defaults to `<repo-root>/data`
  (auto-detected); override with `MAC_STATE_DIR` / `MAC_WORKSPACES_DIR`.

## Sandbox configuration

Agent/workflow commands run in a Mastra `Workspace`. A single `MAC_SANDBOX` env var
(default `auto`) picks the execution mode, from the registry in
`apps/server/src/mastra/workspace.ts`. Workflows/agents are unaffected — they
consume the `Workspace` via the `WorkspaceFactory` seam.

- **Local modes** (built in): `auto` (default; native isolation where available) |
  `local` (no isolation) | `seatbelt` (macOS) | `bwrap` (Linux). The repo is
  checked out into a `checkout/` sub-folder of the per-run workspace root; under
  isolation only that root is writable, and caches (`HOME`/npm/XDG) are redirected
  to the root ALONGSIDE the checkout — never inside it, so `git add -A` can't
  commit them. Knobs: `MAC_SANDBOX_ALLOW_NETWORK`, `MAC_SANDBOX_TIMEOUT_MS`. Verify
  with `node_modules/.bin/tsx scripts/try-sandbox.ts`.
- **Cloud providers** (`e2b`/`daytona`/`modal`/`blaxel`/`agentcore`): opt-in —
  `pnpm --filter @nearform/mac-server add @mastra/<provider>`, add a one-line
  factory to `SANDBOX_PROVIDERS` returning `{ sandbox }`, then `MAC_SANDBOX=<x>`.
  Full table + recipe in `README.md` → "Sandbox".
