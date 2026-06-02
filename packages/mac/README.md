# @nearform/mac

The **MAC** (Mastra Agentic Coding) host. Owns the shared contracts and the
`createMacApp(...)` preset that composes platform, agent, and workflow
extensions into plain registries you spread into a `Mastra` instance.

The host is **platform-agnostic** — it depends only on `@nearform/mac/core`. It
does not import the GitHub, Slack, or agent-workflow packages; those arrive as
extensions through config. That keeps the host generic and the dependency
direction one-way.

## Entry points

| Import | Contents | Weight |
| --- | --- | --- |
| `@nearform/mac` | `createMacApp()`, `MacAppConfig`, `MacPreset`, `MacMcpConfig`/`buildMcpSurface`, plus re-exports of every `/core` contract and authoring helper — the full host API. | preset weight (router + MCP surface) |
| `@nearform/mac/core` | The dependency-light sink: `EventEnvelope`, route/routing types, `MacCapabilityKey`/`capabilityKey()`, `MacExtension`, `defineAgent`/`defineWorkflow`, `Mac*Definition`, `agentRegistryCapability`. | depends on nothing in-scope (`@mastra/core` types only) |

Subpackages (`-github`, `-slack`, `-agent-workflows`) MUST import the contracts
and `define*` helpers from `@nearform/mac/core`, never the root — importing from
the root would create a `subpackage → preset` edge while the preset already
composes the subpackage (a cycle, caught by the Phase 10 dependency-graph test).
App code may import them from the root for convenience.

## `createMacApp(config)`

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { github } from "@nearform/mac-github";
import { slack } from "@nearform/mac-slack";
import { agents, workflows } from "@nearform/mac-agent-workflows";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  platforms: [github(githubConfig), slack(slackConfig)],
  agents: [agents({ use: ["chat", "reviewer"] })],
  workflows: [workflows({ use: ["pr-review", "build"] })],
});

export const mastra = new Mastra({
  agents: mac.agents,
  workflows: mac.workflows,
  server: { apiRoutes: mac.apiRoutes },
  mcpServers: mac.mcpServers,
});

// Long-running connectors (e.g. Slack Socket Mode) start explicitly.
await mac.runtime?.start();
```

`MacAppConfig`:

- `model` — default model id for agents/workflows that don't override it.
- `workspaceFactory?` — app-provided isolated working area per task/run.
- `approvalLinks?` — builds signed approve/reject links for human-in-the-loop gates.
- `platforms?` — `MacExtension[]` (e.g. `github()`, `slack()`); they **provide** capabilities.
- `agents?` — `Array<MacExtension | MacAgentDefinition>`; built-in selectors or custom `defineAgent` definitions.
- `workflows?` — `Array<MacExtension | MacWorkflowDefinition>`; built-in selectors or custom `defineWorkflow` definitions.
- `routing?` — the single override surface (`overrideTargets`, `add`, `classifier.extraIntents`, `includeDefaults`).
- `prompts?` — `{ overrideDir }` for the layered markdown loader.
- `mcp?` — opt-in MCP surface selection/gating. Omitted → MCP off; the embedded path is unaffected.

`MacPreset` (the return value) is plain data ready to spread into `new Mastra(...)`:

```ts
interface MacPreset {
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  apiRoutes: ApiRoute[];
  mcpServers: Record<string, MCPServerBase>;
  mcp: MacMcpSurface;          // resolved, gated MCP manifest
  dispatch: DispatchFn;        // feed normalized EventEnvelopes here
  routes: MacRouteContribution[];
  classifierIntents: MacClassifierIntent[];
  runtime?: { start(): Promise<void>; stop(): Promise<void> };
}
```

`runtime` is omitted when no extension contributes a long-running process. It is
**never auto-started** at module import.

## The extension / capability model

`createMacApp` normalizes `platforms` / `agents` / `workflows` into one ordered
init path:

- Each `MacExtension` declares `provides` / `requires` as typed `MacCapabilityKey`s.
- The host builds a dependency graph, runs `init()` in **topological order**
  (providers before consumers), and throws on cycles or a missing provider
  (preflight, before any `create()` runs).
- Platform extensions `provide(key, value)` configured capability bundles
  (`tools` / `functions` / `servers` / `metadata`) into the shared registry.
  Agent and workflow definitions `require(key)` them back, fully typed.
- Route contributions and classifier intents from extensions are merged with the
  built-in defaults and the host `routing` overrides, then every route/intent
  target is preflighted against the final agent/workflow registries.

Authoring helpers live in `/core`: `defineAgent`/`defineWorkflow` build custom
definitions that are first-class peers of the built-ins (see "Bring Your Own" in
the refactor doc). Reusing a built-in id requires an explicit `overrides`.

## `@nearform/mac/core`

The sink of the dependency graph. It imports only `@mastra/core` types — never a
platform SDK, the preset root, or any agent/workflow package — so subpackages can
depend on it without pulling preset/router/MCP weight. It owns the event
contract, route/routing config types, the capability registry interface + typed
keys, the extension model, the `define*` authoring helpers + `Mac*Definition`
types, and the core `agentRegistryCapability` (so a pure-BYO workflow can resolve
agents without depending on `@nearform/mac-agent-workflows`).

## What this package does NOT own

- GitHub App auth, Octokit clients, webhook crypto → `@nearform/mac-github`.
- Slack Bolt / Socket Mode, mrkdwn formatting → `@nearform/mac-slack`.
- Mastra `Agent` factories, `Workflow` definitions, prompt/skill markdown → `@nearform/mac-agent-workflows`.
- App env reads, storage/memory/logger/observability construction → the consuming app.

See [`docs/examples.md`](../../docs/examples.md) for runnable snippets and
[`docs/mastra-package-refactor.md`](../../docs/mastra-package-refactor.md) for the
full design.
