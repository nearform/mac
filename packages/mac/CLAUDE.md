# packages/mac

Core contracts (`/src/core`) and the MAC app host (`/src/host`).

## Role in the monorepo

- Other packages import from `@nearform/mac/core` (type-level contracts, no platform weight).
- The server app imports from `@nearform/mac` (includes the host preset).

## Critical invariant

`/src/core` **never** imports a platform SDK, Octokit, Slack SDK, or app code.
This is enforced by `test/dependency-graph.test.ts` — if you add an import that
violates it, the test will fail.

## Key concepts

- **`createMacApp`** (`/src/host/create-mac-app.ts`) — assembles the full app from
  extensions, runs topological init ordering, owns the dispatch pipeline
  (pre-rule guards → deterministic routes → LLM classifier).
- **Routing keys** follow `<source>.<event-or-intent>` (e.g. `github.pr_opened`,
  `slack.build`).
- **Capability keys** are string-typed via `capabilityKey<T>(id)` — keeps the
  dependency-injection surface lightweight.
- **Extensions** (`MacExtension`) are the uniform plugin model for platforms, agents,
  and workflows; they run in four phases (0–3).

## Tests

`test/` covers the dependency graph invariant, dispatch router, host extension
ordering, and MCP surface. Run with `pnpm test` from the repo root.
