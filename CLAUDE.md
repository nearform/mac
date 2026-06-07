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

## Testing

- **Write tests, not scripts.** When verifying a new feature or checking a behaviour, add a
  Vitest test under the package or app that owns the code (`packages/**/test/*.test.ts` or
  `apps/**/test/*.test.ts`). Do not add a script to `scripts/` for this purpose.
- Tests use `describe` / `it` / `expect` from `"vitest"` — no globals (disabled in config).
- `scripts/try-sandbox.ts` is a legacy manual probe; new sandbox behaviour should be covered by
  tests in `apps/server/test/`.

## Conventions

- TypeScript ESM throughout; internal imports use `.js` extensions on `.ts` sources
  (packages are source-only, bundled via `transpilePackages`).
- Local state (sqlite/duckdb/`workspaces/`) defaults to `<repo-root>/data`
  (auto-detected); override with `MAC_STATE_DIR` / `MAC_WORKSPACES_DIR`.
- Each subdirectory has its own `CLAUDE.md` with package-specific conventions —
  read it before working in that area.
