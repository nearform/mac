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

Local state (the SQLite DB, the DuckDB observability file, and the per-run sandbox
`workspaces/`) defaults to `<repo-root>/data/` — auto-detected, no absolute paths
needed. Override with `MAC_STATE_DIR` / `MAC_WORKSPACES_DIR`.

### Sandbox

Agents/workflows run shell commands inside a [Mastra `Workspace`](https://mastra.ai/docs/workspace/sandbox).
A single **`MAC_SANDBOX`** env var (default `auto`) picks the execution mode, from a
registry in `apps/server/src/mastra/workspace.ts`. Local modes are built in; cloud
providers are opt-in (install the package + register a one-line factory).

| `MAC_SANDBOX` | Where | Isolation | Needs |
| --- | --- | --- | --- |
| `auto` (default) | local host | native (Seatbelt/bwrap) if available, else none | — |
| `local` | local host | none (direct execution) | — |
| `seatbelt` | local host | macOS `sandbox-exec` | macOS |
| `bwrap` | local host | Linux bubblewrap | bubblewrap installed |
| `e2b` | cloud | remote (own VM/container) | `@mastra/e2b` + `E2B_API_KEY` |
| `daytona` | cloud | remote | `@mastra/daytona` + creds |
| `modal` / `blaxel` / `agentcore` | cloud | remote | `@mastra/modal` / `@mastra/blaxel` / `@mastra/agentcore-runtime` |

Under a local isolation mode the per-run workspace **root** (plus `/tmp` and standard
device nodes like `/dev/null`) is the **only writable host area**. The repo is
checked out into a `checkout/` sub-folder of that root, and tool caches (`HOME`, npm,
XDG) are redirected to the root **alongside** the checkout — never **inside** it.
So a run never writes to host `~/.npm`/`~/.cache`, and the caches stay out of the git
tree (the workflow's `git add -A` can't sweep them into a commit). Knobs:
`MAC_SANDBOX_ALLOW_NETWORK=0` blocks network; `MAC_SANDBOX_TIMEOUT_MS` sets the
per-command timeout.

```bash
MAC_SANDBOX=local pnpm dev      # no isolation (trusted dev)
MAC_SANDBOX=auto  pnpm dev      # isolate where the OS supports it (default)
```

**Adding a cloud provider** — two steps (E2B example):

```bash
pnpm --filter @nearform/mac-server add @mastra/e2b
```

```ts
// apps/server/src/mastra/workspace.ts — add to SANDBOX_PROVIDERS:
import { E2BSandbox } from "@mastra/e2b";                       // needs E2B_API_KEY
const SANDBOX_PROVIDERS = {
  e2b: () => ({ sandbox: new E2BSandbox({ timeout: 15 * 60_000 }) }),
};
```

Then run with `MAC_SANDBOX=e2b`. Cloud factories return `{ sandbox }` only (they
bring their own filesystem); everything downstream (workflows, agents) is unchanged
— they consume the `Workspace` via the `WorkspaceFactory` seam.

Verify isolation locally (workspace + cache writes succeed; `$HOME` blocked):

```bash
node_modules/.bin/tsx scripts/try-sandbox.ts        # runs: local, then seatbelt
```

## Design

- [MAC Package Refactor](docs/mastra-package-refactor.md) — the package-boundary design.
- [Examples](docs/examples.md) — minimal `createMacApp` snippets.
- [Changelog](CHANGELOG.md) — versioning policy and the refactor entry.
