# MAC — Mastra Agentic Coding

**MAC** (Mastra Agentic Coding) — a GitHub repo-maintenance agent built as an
idiomatic [Mastra](https://mastra.ai) v1 app and refactored into a reusable
package set. The deployable reference unit is `apps/server`; the reusable
building blocks are the `@nearform/mac*` packages.

## The `@nearform/mac*` package set

MAC (Mastra Agentic Coding) is a composable set of Mastra building blocks. A
default Mastra project installs the preset, selects GitHub/Slack surfaces, and
registers agents, workflows, tools, connectors, and MCP exports without copying
app code.

| Package | Purpose |
| --- | --- |
| [`@nearform/mac`](packages/mac/README.md) | Host + contracts: `createMacApp()` preset and the dependency-light `@nearform/mac/core`. The host is platform-agnostic (depends only on `/core`). |
| [`@nearform/mac-github`](packages/mac-github/README.md) | GitHub platform: App auth, tools, webhook, and the `github()` extension. |
| [`@nearform/mac-slack`](packages/mac-slack/README.md) | Slack platform: Socket Mode connector, notify helpers, and the `slack()` extension. |
| [`@nearform/mac-agent-workflows`](packages/mac-agent-workflows/README.md) | Built-in agents, workflow definitions/factories, and markdown instructions. |

Dependency direction (acyclic, asserted by `packages/mac/test/dependency-graph.test.ts`):
`@nearform/mac/core` is the sink; the platform packages depend on `@nearform/mac`;
`@nearform/mac-agent-workflows` depends on `@nearform/mac` plus the type-only
`/capabilities` of the platform packages. No package depends on the app.

See **[docs/examples.md](docs/examples.md)** for runnable snippets (minimal PR
reviewer, GitHub webhook app, Slack chat connector, full preset).

## Layout

```
apps/server/          # the deployable reference Mastra app (composes via createMacApp)
packages/mac/            # host + /core contracts
packages/mac-github/     # GitHub platform extension
packages/mac-slack/      # Slack platform extension
packages/mac-agent-workflows/  # agents, workflows, markdown assets
packages/mac-cli/  # thin HTTP CLI client that triggers the running server
CHANGELOG.md             # versioning policy + the MAC refactor entry
MIGRATION.md             # mapping, pinned API signatures, dropped/deferred log
docs/                    # design docs (refactor design + examples)
```

## Develop

Requires [pnpm](https://pnpm.io) (the version is pinned via the `packageManager`
field; `corepack enable` once will provision it for you if you don't have it).

```bash
pnpm install                      # one-time
pnpm dev                          # server (:4111) + Studio (http://localhost:3000)
pnpm cli <owner/repo#N>           # trigger a run against the running server
pnpm -C apps/server typecheck
```

`apps/server/.env` holds service config (Anthropic/OpenRouter keys, GitHub App, Slack,
models) copied from the original. See `MIGRATION.md` for what's intentionally dropped/deferred
in this spike (notably the network-egress firewall).

## Design

- [MAC Package Refactor](docs/mastra-package-refactor.md) — the package-boundary design.
- [Examples](docs/examples.md) — minimal `createMacApp` snippets.
- [Changelog](CHANGELOG.md) — versioning policy and the refactor entry.
