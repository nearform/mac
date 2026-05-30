# lastlight-mastra

A spike: [Last Light](../lastlight) (GitHub repo-maintenance agent) rebuilt as an idiomatic
[Mastra](https://mastra.ai) v1 app. The deployable unit is `apps/maintenance`.

## Layout

```
apps/maintenance/        # the deployable Mastra app (Hono server via `mastra build`)
  src/mastra/index.ts    # Mastra entry: storage, logger, agents, workflows, server.apiRoutes
prompts/                 # phase prompt templates (copied from lastlight)
skills/                  # agent skills (copied from lastlight)
agent-context/           # persona/rules prepended to agent sessions (copied from lastlight)
MIGRATION.md             # mapping, pinned API signatures, dropped/deferred log
```

## Develop

```bash
corepack pnpm install                      # one-time
corepack pnpm -C apps/maintenance dev      # mastra dev → server + Studio (http://localhost:4111)
corepack pnpm -C apps/maintenance build    # mastra build → .mastra/output (deployable Hono server)
corepack pnpm -C apps/maintenance typecheck
```

`apps/maintenance/.env` holds service config (Anthropic/OpenRouter keys, GitHub App, Slack,
models) copied from lastlight. See `MIGRATION.md` for what's intentionally dropped/deferred
in this spike (notably the network-egress firewall).
