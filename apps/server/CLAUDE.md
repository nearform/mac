# apps/server

The deployable Mastra server that composes all packages into a running app with GitHub
webhooks, Slack Socket Mode, approval gates, and an optional interactive Harness.

## Key conventions

- **`src/load-env.ts` must be the first import** in any entry point. It loads
  `<repo-root>/secrets/.env` before any other module reads `process.env`.
- **Platforms install conditionally.** `github()` and `slack()` extensions are only
  registered when their secrets are present; the app boots without them.
- **Request context** (`RC_TASK_ID`, `RC_TOKEN`, `RC_SKILLS`) is threaded per-run via
  Mastra's `requestContext` so agents can read their scoped token without global state.
- **CORS middleware echoes the `Origin` header** (required for Mastra Studio). Do not
  replace it with a fixed allow-list.
- **Approval links are HMAC-signed.** The link factory in `src/mastra/config.ts` uses
  `publicBaseUrl` + a secret. Never generate unsigned approval links.

## Sandbox

`MAC_SANDBOX` (default `auto`) picks the execution mode. Available local modes:
`local` | `seatbelt` (macOS) | `bwrap` (Linux) | `auto`.

- The repo is checked out into `checkout/` inside the per-run workspace root.
- Under isolation, caches (`HOME`/npm/XDG) redirect to the workspace root alongside
  `checkout/` — never inside it, so `git add -A` cannot commit them.
- Knobs: `MAC_SANDBOX_ALLOW_NETWORK`, `MAC_SANDBOX_TIMEOUT_MS`.
- Sandbox behaviour is verified by tests in `apps/server/test/`; run `pnpm test`.

Cloud providers (`e2b`, `daytona`, `modal`, `blaxel`, `agentcore`) are opt-in — see
`README.md → Sandbox` for the full table and recipe.

## Entry points

| File | Role |
|------|------|
| `src/server.ts` | Hono server; starts Slack Socket Mode after `listen()` |
| `src/mastra/index.ts` | Mastra instance; composes agents, workflows, platforms |
| `src/mastra/workspace.ts` | Per-task code sandbox (`createCodeWorkspace`) |
| `src/mastra/harness.ts` | Interactive Harness (opt-in: `MAC_INTERACTIVE_HARNESS=1`) |
