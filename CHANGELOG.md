# Changelog

All notable changes to the `@nearform/mac*` packages are recorded here. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/), and
the packages aim to follow [Semantic Versioning](https://semver.org/).

## Versioning policy

- All `@nearform/mac*` packages (`@nearform/mac`, `@nearform/mac-github`,
  `@nearform/mac-slack`, `@nearform/mac-agent-workflows`) **version together**
  for now: they ship from one repo, share the `@nearform/mac` contracts, and are
  released as a set. A change to the core contracts is a change to all of them.
- While the API is pre-1.0 (`0.x`), minor versions may carry breaking changes;
  breaks are called out in the entry. Once the host/extension API stabilizes we
  will move to independent or coordinated semver under `1.x`.
- The capability keys and `/core` + `/capabilities` subpath exports are the
  stable public surface; internal module layout may change without a major bump.

## [Unreleased] — MAC package refactor (0.x)

Introduces the MAC (Mastra Agentic Coding) reusable package set, extracting the
former single `apps/maintenance` app into composable building blocks. The app
remains as the reference consumer.

### Added

- **`@nearform/mac`** — the host: `createMacApp(config)` preset, `MacAppConfig` /
  `MacPreset`, the extension/capability model, optional MCP surface
  (`MacMcpConfig` / `buildMcpSurface`), and the dependency-light `@nearform/mac/core`
  subpath (event/route contracts, capability keys, `defineAgent`/`defineWorkflow`,
  `agentRegistryCapability`). The host depends only on `/core`.
- **`@nearform/mac-github`** — GitHub platform: App auth, permission profiles,
  Octokit factories, read/write tools, issue/PR helpers, webhook route, and the
  `github()` extension. Replaces `@lastlight/github`. Type-only `/capabilities`.
- **`@nearform/mac-slack`** — Slack platform: Socket Mode connector, notify
  helpers, mrkdwn formatting, and the `slack()` extension. Type-only
  `/capabilities`.
- **`@nearform/mac-agent-workflows`** — built-in agents (`agents({ use })`),
  workflow definitions/factories (`workflows({ use })`,
  `prReviewWorkflowDefinition`, `buildWorkflowDefinition`), markdown instruction
  assets with a layered override loader, and the `agentCapabilities` bundle.
- Package READMEs, `docs/examples.md`, and a dependency-cycle test asserting the
  `@nearform/*` graph is acyclic with `@nearform/mac` as the sink.

### Changed

- `@lastlight/github` is **fully replaced** by `@nearform/mac-github`; no
  compatibility shim is retained (see `MIGRATION.md`).
