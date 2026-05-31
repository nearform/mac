# MAC (Mastra Agentic Coding) Package Refactor

> Package scope: `@nearform`. Packages: `@nearform/mac`, `@nearform/mac-github`, `@nearform/mac-slack`, `@nearform/mac-agent-workflows`. Host factory: `createMacApp(...)`; public types use the `Mac*` prefix. (Renamed from the former `@lastlight/*` / `LastLight*` naming.)

## Purpose

MAC should become a reusable set of Mastra building blocks, not a single deployable app. A default Mastra project should be able to install the MAC preset, select GitHub and Slack surfaces, and register agents, workflows, tools, connectors, and MCP exports without copying application code.

This design keeps the current `apps/maintenance` app as the reference implementation while extracting reusable packages behind stable APIs.

## Design Principles

### Workflows Orchestrate

Workflows are state machines. They own ordering, branching, loops, gates, retries, state passing, and deterministic side effects. They do not own intelligence.

Allowed in workflow modules:

- Mastra workflow and step definitions.
- Structured schemas for workflow input, output, state, suspend, and resume data.
- Calls to named agents from `@nearform/mac-agent-workflows`.
- Calls to tools or deterministic helper functions from tool packages.
- Parsing structured agent outputs.
- Deterministic platform writes, such as posting a review, updating a status comment, opening a PR, or resuming a suspended run.

Not allowed in workflow modules:

- Inline skill bodies.
- Inline prompt bodies.
- Large instruction strings.
- Workflow-module-owned `skills/`, `prompts/`, or `agent-context/` directories.
- Direct LLM calls except through named agents.
- Agent factories containing substantial instructions inside workflow files.

The working rule is:

```txt
Workflows orchestrate. Agents decide. Markdown instructs.
```

### Shared Agent/Workflow Package Owns Markdown Instructions

All skills, prompts, and persona/context files live in `@nearform/mac-agent-workflows` as markdown assets. TypeScript code may load and compose markdown, but the durable instruction content stays in `.md` files.

Markdown is overridable without forking. A consuming app supplies an override directory; the loader resolves `overrideDir/<key>.md` first and falls back to the package default. This is how a team adjusts a built-in agent's instructions quickly. See "Layered Prompt and Skill Resolution".

Agents and workflows live in the same package so workflow factories can call local agent factories without forcing cross-package churn. They are selected independently — `agents({ use: [...] })` and `workflows({ use: [...] })` — so a consuming app can install agents, workflows, or both. Agents are constructed once and registered; workflows consume the *registered instances* through the capability registry rather than constructing their own (this preserves observability tracing — see "Agent Factory Bundle").

The internal boundary still matters: workflow files orchestrate, agent files create agents, and markdown files hold durable instructions.

Allowed in agent code:

- Agent factories.
- Prompt and skill loaders.
- Small glue text for output contracts or runtime metadata.
- Structured output parsing helpers.
- References to prompt and skill keys.

Not allowed in agent code:

- Full prompt bodies.
- Skill procedures.
- Persona/rules/security text.
- Workflow-specific prompt directories.

### Tools Are Capability Surfaces

Tool packages expose capabilities that agents and workflows can call. They may include Mastra `createTool()` definitions and lower-level deterministic functions when workflows need to perform a write after an agent has produced a decision.

Tool packages should not start listeners, own webhooks, or decide how events route through the system.

### Connectors Own Inbound and Outbound Platform Plumbing

Connector packages translate external platform events into the shared event model and provide platform-specific delivery/notifier helpers. They do not contain agent instructions or workflow logic.

### The Top-Level Package Owns Core Contracts

`@nearform/mac` contains both the shared contracts and the helper/preset API. Its core exports should stay platform-light. GitHub and Slack SDKs belong in their tool or connector packages.

Because subpackages need shared event/router types, and the preset needs to compose subpackages, `@nearform/mac` should be internally layered:

- Core exports: dependency-light contracts, router types, route config, and shared helpers.
- Preset exports: composition helpers that wire optional subpackages together.

The core layer must not import GitHub, Slack, agent, or workflow packages. Preset code may import or dynamically load those packages.

### The App Is a Consumer

`apps/maintenance` should become a thin composition app:

- Reads local env/config.
- Creates storage, memory, logger, observability, and workspace factories.
- Calls the preset from `@nearform/mac`.
- Starts runtime-only connectors such as Slack Socket Mode.
- Registers the returned agents, workflows, routes, and MCP servers.

## Target Package Set

```txt
@nearform/mac
@nearform/mac-github
@nearform/mac-slack
@nearform/mac-agent-workflows
```

## Package Responsibilities

### `@nearform/mac`

Shared contracts, platform-neutral orchestration helpers, and the top-level helper/preset API.

Owns:

- `EventEnvelope`
- `EventType`
- `DispatchFn` and the `runtime.start()/stop()` lifecycle shape (the system dispatches plain envelopes; do **not** resurrect the unused `EventEmitter`-based `Connector` from the current `connectors/types.ts` as public API)
- `RoutingResult`
- `RouteConfig`
- default route table
- router interfaces
- classifier and screener interfaces
- managed-repo interfaces
- shared error/result types
- `createMacApp(...)` (preset layer)
- default package composition (preset layer)
- optional MCP server creation (preset layer)
- package-level install ergonomics
- app-facing types for configuration

Owned by the **core layer** (`@nearform/mac/core`) so subpackages can import them without pulling preset/runtime code (re-exported from the root only for app ergonomics):

- `defineAgent(...)` / `defineWorkflow(...)` authoring helpers
- `MacAgentDefinition` / `MacWorkflowDefinition`
- `MacExtension`, `MacExtensionContext`, `MacExtensionResult`
- the capability registry interface, typed `MacCapabilityKey<T>`, and `capabilityKey()`
- the core agent-registry capability key (see "Agent Bundle")

> **Dependency-cycle guard:** these contracts MUST live in `/core`, never the preset root. Subpackages (`-github`, `-slack`, `-agent-workflows`) author their built-in definitions with `defineWorkflow`/`defineAgent` imported from `@nearform/mac/core`. Importing them from the `@nearform/mac` root instead would create `subpackage → preset` while the preset already composes the subpackage — a cycle, caught by the Phase 10 "no cycles" gate.

May own:

- The existing deterministic router once GitHub/Slack-specific assumptions are abstracted behind route context.
- Prompt-injection screener wrapper interfaces.
- Build-intent classifier interfaces and parsers.

Should not own:

- GitHub App auth.
- Slack Bolt clients.
- Mastra Agent factories.
- Mastra Workflow definitions.
- Markdown skills or prompts.
- Hard-coded local app env behavior.

Initial sources:

- `apps/maintenance/src/mastra/connectors/types.ts`
- `apps/maintenance/src/mastra/engine/routes.ts`
- `apps/maintenance/src/mastra/engine/router.ts`
- `apps/maintenance/src/mastra/engine/classifier.ts`
- `apps/maintenance/src/mastra/engine/screen.ts`
- `apps/maintenance/src/mastra/engine/llm.ts`
- `apps/maintenance/src/mastra/managed-repos.ts`

Example target API:

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { github } from "@nearform/mac-github";
import { slack } from "@nearform/mac-slack";
import { agents, workflows } from "@nearform/mac-agent-workflows";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  // Config is grouped by role rather than flattened into one extensions array.
  // The host initializes platforms (providers) before agents/workflows
  // (consumers) regardless of the order they appear in, so wiring is
  // order-independent. See "Extension Model".
  platforms: [
    github({
      appId: process.env.GITHUB_APP_ID!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
      webhookSecret: process.env.WEBHOOK_SECRET!,
      managedRepos: ["nearform/example-repo"],
    }),
    slack({
      botToken: process.env.SLACK_BOT_TOKEN,
      appToken: process.env.SLACK_APP_TOKEN,
      allowedUsers: [],
    }),
  ],
  // Both `agents` and `workflows` are arrays of (built-in selector | custom definition),
  // so bringing your own is symmetric across the two. See "Bring Your Own".
  agents: [agents({ use: ["chat", "reviewer"] })],
  workflows: [workflows({ use: ["pr-review", "build"] })],
});

export const mastra = new Mastra({
  agents: mac.agents,
  workflows: mac.workflows,
  server: {
    apiRoutes: mac.apiRoutes,
  },
  mcpServers: mac.mcpServers,
});

// Long-running connectors (e.g. Slack Socket Mode) start explicitly.
await mac.runtime?.start();
```

Recommended export shape:

```txt
@nearform/mac              # root: createMacApp, preset, router, MCP, + re-exports of the /core authoring helpers
@nearform/mac/core         # dependency-light contracts AND authoring helpers: EventEnvelope, route/capability types,
                           #   MacCapabilityKey, capabilityKey(), MacExtension, defineAgent/defineWorkflow, Mac*Definition
```

`defineAgent`/`defineWorkflow` are *defined* in `/core` (they are pure constructors with no preset dependency) and *re-exported* from the root. App code may import them from the root for convenience; **subpackages must import them from `/core`** to keep the dependency direction one-way (see the cycle guard above).

Subpath exports exist to isolate **dependencies**, not to organize namespaces. The guiding rule: add a subpath only when a consumer must import something *without* pulling a heavy transitive dependency. `@nearform/mac/core` earns its place because subpackages import its contracts and authoring helpers and must not pull preset/router runtime. Routing, preset composition, and MCP helpers share the root's dependency weight, so they stay in the root rather than becoming separate entry points. Add more entry points later only when a real consumer hits a dependency it should not pull.

Subpackages should import shared types and the `define*` helpers from `@nearform/mac/core`. This keeps the contract import clearly separated from preset composition.

### `@nearform/mac-github`

GitHub platform package. It owns both capabilities exposed to agents/workflows and connector plumbing for inbound GitHub events.

Owns:

- GitHub App config types.
- GitHub permission profiles.
- Installation token minting.
- Octokit client factories.
- Read-only Mastra GitHub tools.
- Issue comment helpers.
- Issue reaction helpers.
- PR review helpers.
- PR/write tools that are explicitly safe to expose.
- GitHub webhook signature verification.
- GitHub webhook event filtering.
- GitHub payload normalization to `EventEnvelope`.
- `createGithubWebhookRoute(...)`.
- GitHub issue/PR reply closures.
- Status-comment publisher helpers, if they are connector-level rather than workflow-level.

Initial sources:

- `packages/github/src/*`
- `apps/maintenance/src/mastra/engine/github-normalize.ts`
- `apps/maintenance/src/mastra/server/github-webhook.ts`

Depends on:

- `@nearform/mac/core`

Should not own:

- PR review agent logic.
- Build workflow logic.
- Prompt or skill markdown.

Recommended export shape:

```txt
@nearform/mac-github               # root: github() extension, tools, connector, auth — the full runtime API
@nearform/mac-github/capabilities  # type-only: GithubCapabilities + the githubCapabilities key (no Octokit at import)
```

Start with these two entry points. The `/capabilities` path is justified because the agent-workflow package imports `GithubCapabilities` and `githubCapabilities` as `import type` and must not transitively pull Octokit, webhook crypto, or env loaders. Split out `/tools`, `/connector`, or `/auth` later only if a consumer proves it needs one of those surfaces without the others' dependencies — do not pre-partition.

Notes:

- This package replaces the current `@lastlight/github` package.
- It may expose both Mastra tools and deterministic helper functions.
- Write helpers should remain separated by profile or factory so callers opt in to write scope intentionally.
- Connector exports must not start listeners or perform network work at module import time.
- The root export should include `github(config)` for common preset wiring.

### `@nearform/mac-slack`

Slack platform package. It owns both capabilities exposed to agents/workflows and connector plumbing for Slack Socket Mode ingestion.

Owns:

- Slack Web API helper factories.
- Message posting tools.
- Thread status helpers.
- User/channel lookup helpers.
- Markdown-to-Slack formatting helpers.
- Any Slack Mastra tools exposed to agents or workflows.
- Slack Socket Mode connector.
- Message gating and allowlist handling.
- Mention stripping.
- Active-thread continuation policy.
- Slack message normalization to `EventEnvelope`.
- Runtime `startSlackConnector(config, dispatch)` helper.

Initial sources:

- `apps/maintenance/src/mastra/connectors/slack/mrkdwn.ts`
- `apps/maintenance/src/mastra/connectors/slack/connector.ts`
- Slack posting/status helper logic currently embedded in `connector.ts`

Depends on:

- `@nearform/mac/core`

Notes:

- This package starts long-running runtime processes. It should not create module-load side effects.
- The reference app should start it from `src/server.ts`, after the HTTP server is listening.
- Tool exports should not start Socket Mode.
- Connector exports should keep runtime start/stop explicit.

Recommended export shape:

```txt
@nearform/mac-slack               # root: slack() extension, tools, Socket Mode connector — the full runtime API
@nearform/mac-slack/capabilities  # type-only: SlackCapabilities + the slackCapabilities key (no Bolt at import)
```

Same principle as GitHub: start with root + the dep-light `/capabilities`. Split runtime surfaces out only when a consumer proves it needs one without the others.

### `@nearform/mac-agent-workflows`

Reusable MAC agents, workflow factories, and all markdown instruction assets.

Owns:

- Agent factories:
  - chat
  - reviewer
  - build reviewer
  - guardrails
  - architect
  - executor
  - fixer
  - sandbox probe, if still useful
- Prompt loader.
- Skill loader.
- Agent-context loader.
- Structured output parsers.
- Default route targets and classifier labels for the agents and workflows this package contributes.
- Workflow factories:
  - `createPrReviewWorkflow(deps)`
  - `createBuildWorkflow(deps)`
  - future workflow factories for issue triage, issue comment, PR comment, PR fix, security review, security feedback, repo health, explore, and cron workflows
- Markdown assets:
  - `prompts/*.md`
  - `skills/**/SKILL.md`
  - `skills/**/DESCRIPTION.md`
  - `agent-context/*.md`

Initial sources:

- `apps/maintenance/src/mastra/agents/*`
- `apps/maintenance/src/mastra/workflows/pr-review.ts`
- `apps/maintenance/src/mastra/workflows/build.ts`
- `apps/maintenance/src/mastra/agent-context.ts`
- root `prompts/`
- root `skills/`
- root `agent-context/`

Rules:

- Prompts and skills stay in markdown files, resolved through a layered loader (app override dir wins over package default — see "Layered Prompt and Skill Resolution").
- Agent factories accept dependency objects instead of reading global app config. No `process.env` / `*FromEnv` reads inside package agent or workflow code.
- Agent factories may accept prompt keys and skill keys; the package resolves those keys to markdown assets via the layered loader.
- Output contracts should be represented by markdown prompt text plus parser functions or schemas.
- **Workflows consume registered agent instances, not agent factories.** `agents()` constructs each agent once and publishes the same instances under `agentCapabilities`; a workflow's `create()` does `capabilities.require(agentCapabilities).reviewer`. Workflows never call `new Agent(...)` or `create*Agent(...)`, which would produce an unregistered, untraced duplicate (see "Agent Factory Bundle").
- Workflow files call external tool/helper packages through injected capabilities.
- Workflow files may request prompt or skill keys, but do not own prompt or skill content.
- Workflows are created by `defineWorkflow` factories so dependencies are explicit and testable.
- `agents({ use: [...] })` selects and registers built-in agents and their default route targets.
- `workflows({ use: [...] })` selects and registers built-in workflows and their default route targets; the host also accepts custom `defineWorkflow(...)` definitions directly (see "Bring Your Own").
- Apps may install agents without workflows, or workflows without a standalone chat agent. When a workflow requires an agent, the host pulls it in transitively (see "Transitive agent dependencies") so the app author does not repeat the requirement.

Internal agent factory (package-private; the `prompt`/`skills`/`context` keys resolve through the layered loader). Per-run values like `token`/`taskId` are **not** construction args — they flow through `requestContext` at `generate()` time, so the agent is built once:

```ts
const reviewer = createReviewAgent({
  model,
  prompt: "reviewer",
  skills: ["pr-review"],
  context: ["rules", "security", "soul"],
});
```

Public extension API — `use:` selects built-ins; workflow factories receive injected capabilities. The `agents()` selector also accepts an optional per-agent `models` map for model overrides at selection time:

```ts
export interface AgentsSelector {
  use: string[];
  /** Optional per-agent model override, keyed by agent id. Falls back to the host `model`. */
  models?: Record<string, string>;
}
export interface WorkflowsSelector {
  use: string[];
}

const agentBundle = agents({
  use: ["chat", "reviewer", "architect", "executor"],
  models: { architect: "anthropic/claude-opus-4-8" }, // optional
});
const workflowBundle = workflows({ use: ["pr-review", "build"] });

// Workflow factories receive configured capabilities (github = github.functions/tools,
// agents = registered instances) rather than reaching for global config:
const prReviewWorkflow = createPrReviewWorkflow({ github, agents, workspaceFactory });
const buildWorkflow = createBuildWorkflow({
  github,
  agents,
  workspaceFactory,
  approvalLinks,
  statusPublisher,
});
```

#### Layered Prompt and Skill Resolution

Adjusting a built-in agent's instructions must not require forking the package. A `PromptResolver` resolves a key against an ordered set of directories: the app's override dir first, then the package default.

```ts
export interface PromptResolver {
  /** Returns the markdown for `key`, app override dir first, package default last. */
  resolve(key: string): string;
}

// host config:
createMacApp({ /* ... */, prompts: { overrideDir: "./prompts" } });
```

Resolution order for key `reviewer`: `overrideDir/reviewer.md` → package `prompts/reviewer.md`. The same layering applies to `skills/` and `agent-context/`. This generalizes the existing `loadAgentContext()` (`apps/maintenance/src/mastra/agent-context.ts`), which already supports a `LASTLIGHT_AGENT_CONTEXT_DIR` override.

**Implementation warning:** the package default must resolve relative to the package's own compiled location via `import.meta.url`, **not** by walking `cwd`/relative candidate paths. The current `loadAgentContext()` guesses with `../../../../agent-context` and `process.cwd()` candidates — that breaks once the assets live in a package resolved from `node_modules`. Keep cwd-relative lookup only for the app-supplied `overrideDir`.

#### Transitive agent dependencies

A workflow that `requires: [agentCapabilities]` cannot run without the concrete agent ids it uses. Each workflow definition declares those ids:

```ts
export const prReviewWorkflowDefinition = defineWorkflow({
  id: "pr-review",
  requires: [githubCapabilities, agentCapabilities],
  requiredAgents: ["reviewer"],
  create: ({ capabilities }) => {
    const agents = capabilities.require(agentCapabilities);
    return createPrReviewWorkflow({ reviewer: agents.reviewer });
  },
});
```

The host resolves this transitively: enabling `workflows({ use: ["pr-review"] })` ensures the `reviewer` agent is registered even if the app author did not list `agents({ use: ["reviewer"] })`. If the agent genuinely cannot be provided, this surfaces as a preflight error (`pr-review requires agent "reviewer"`), never a mid-run failure. The app author satisfies high-level intent ("enable pr-review"); the host satisfies the dependency graph.

**On the `requiredAgents` string list — an honest tradeoff.** This is a stringly list paralleling code, the same shape this design rejected for capability `surface`/`uses` (see "Capability Wiring"). It is kept here for one reason the typed key cannot serve: the host must know *which agent ids* to auto-enable transitively, and the `agentCapabilities` key alone does not enumerate them. The drift risk is asymmetric: a *declared-but-absent* agent is caught at preflight, but a *used-but-undeclared* one (e.g. `create()` reaches for `agents.architect` while `requiredAgents` lists only `reviewer`, and architect is not otherwise enabled) would be `undefined` at runtime. To convert that into a clear, early error, the injected agent value is a **guarded proxy**: accessing an id not in `requiredAgents` throws `workflow "pr-review" accessed agent "architect" not declared in requiredAgents` rather than returning `undefined`. So both failure modes are loud, and `requiredAgents` stays the single list the host reads for transitive enabling.

## Cross-Package Dependency Direction

```txt
@nearform/mac/core
  ^
  |
  +-- @nearform/mac-github
  |
  +-- @nearform/mac-slack
  |
  +-- @nearform/mac-agent-workflows
        · · · (type-only) · · ·> @nearform/mac-github/capabilities
        · · · (type-only) · · ·> @nearform/mac-slack/capabilities

@nearform/mac  (root: preset/router/host)
  depends on selected subpackages for the batteries-included helper
```

The agent-workflow package must not import GitHub or Slack platform packages **at runtime** — it consumes configured platform capabilities through dependency injection from the capability registry. The only allowed edge to a platform package is a **type-only** `import type` of its `/capabilities` contract (e.g. `GithubCapabilities`, `githubCapabilities`), which carries no runtime dependency (no Octokit, no Bolt). The dotted edges above mark exactly that. Its exported extensions are separate so apps can compose surfaces independently:

- Platform/app extensions: GitHub, Slack, future Linear/email/CLI.
- Agent extensions: chat/reviewer/architect/executor agents.
- Workflow extensions: PR review, build, triage, security, repo-health workflows.

The dependency-light core exports are the shared foundation. The preset layer depends on the packages it composes. No lower package depends on the preset layer.

## Extension Model

`createMacApp(...)` is composable. GitHub, Slack, agents, and workflows are installed as **extensions** — uniform plug-ins rather than hard-coded options — so the host stays open to future platforms such as Discord, Linear, email, cron, or local CLI triggers. The host config groups those inputs by role (`platforms` / `agents` / `workflows`) for readability. Extensions, custom agent definitions, and custom workflow definitions are normalized into one init/merge path.

An extension is a function that receives shared MAC context and returns one or more Mastra registries, runtime hooks, dispatch hooks, and capabilities.

```ts
export interface MacExtension {
  name: string;
  /** Capabilities this extension publishes into the registry (e.g. githubCapabilities). */
  provides?: MacCapabilityKey<unknown>[];
  /** Capabilities this extension consumes. The host uses these to order init. */
  requires?: MacCapabilityKey<unknown>[];
  init(context: MacExtensionContext): MacExtensionResult | Promise<MacExtensionResult>;
}

export interface MacExtensionContext {
  model: string;
  workspaceFactory?: WorkspaceFactory;
  dispatch: DispatchFn;
  capabilities: MacCapabilityRegistry;
}

export interface MacExtensionResult {
  agents?: Record<string, Agent>;
  workflows?: Record<string, Workflow>;
  apiRoutes?: ApiRoute[];
  mcpServers?: Record<string, MCPServer>;
  routes?: MacRouteContribution[];
  classifierIntents?: MacClassifierIntent[];
  runtime?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}
```

Capabilities are **not** returned in the result. An extension publishes them imperatively and type-safely via `context.capabilities.provide(key, value)` during `init` (see "Capability Wiring"), so consumers retrieve them through the same typed keys. Keeping a second untyped `capabilities` bag on the result would reintroduce the dual-source-of-truth problem this design removed.

```ts
// inside init(context):
context.capabilities.provide(githubCapabilities, githubBundle);
```

The top-level preset merges extension results:

- Agents are merged into the final `agents` registry.
- Workflows are merged into the final `workflows` registry.
- API routes are appended to `server.apiRoutes`.
- MCP servers are merged into the final `mcpServers` registry.
- Route contributions are appended to the configurable router.
- Classifier intents are appended to the configurable intent catalogue.
- Capabilities were already published into the shared registry during each extension's `init` (via `context.capabilities.provide`), so later extensions — run after providers thanks to topological ordering — can read them.
- Runtime hooks are combined into one start/stop object.

Host configuration groups extensions by role rather than flattening them into a single array:

```ts
const mac = await createMacApp({
  model,
  workspaceFactory,
  platforms: [github(githubConfig), slack(slackConfig)],
  agents: [agents({ use: ["chat", "reviewer", "architect", "executor"] })],
  workflows: [workflows({ use: ["pr-review", "build"] })],
});
```

The `platforms` / `agents` / `workflows` split communicates the layering directly: platforms **provide** capabilities; agents and workflows **consume** them. `agents` and `workflows` are both arrays of (built-in selector | custom `defineAgent`/`defineWorkflow` definition), so BYO is symmetric across the two — see "Bring Your Own".

Explicit host config shape:

```ts
export interface MacAppConfig {
  model: string;
  workspaceFactory?: WorkspaceFactory;
  platforms?: MacExtension[];
  agents?: Array<MacExtension | MacAgentDefinition>;
  workflows?: Array<MacExtension | MacWorkflowDefinition>;
  routing?: MacRoutingConfig;
  prompts?: { overrideDir?: string };
}
```

Normalization rules:

- `platforms` entries must be `MacExtension`s.
- `agents` entries may be `MacExtension`s or custom `MacAgentDefinition`s.
- `workflows` entries may be `MacExtension`s or custom `MacWorkflowDefinition`s.
- Custom definitions are wrapped in small internal extensions before dependency ordering.
- Duplicate ids fail unless the later definition explicitly declares `overrides`.
- Route targets are validated against the final agent/workflow registries before runtime starts.

**Ordering is the host's job, not the author's.** Each extension declares `provides` and `requires` as typed capability keys. The host builds a dependency graph, runs init in topological order (providers before consumers), and detects cycles. So `workflows()` always sees the GitHub and agent capabilities it consumes, regardless of how the config is written. The host validates required capabilities before any `create()` runs and produces a clear operator-facing error on a missing provider (see "Capability Wiring").

Platform packages expose their extension and runtime API from the root export, with the dep-light type contract on `/capabilities`:

```ts
import { github } from "@nearform/mac-github";
import type { GithubCapabilities } from "@nearform/mac-github/capabilities";
```

## Capability Wiring

Platform extensions produce configured capabilities. Agent and workflow extensions consume those capabilities through the shared registry. This keeps package dependencies clean and makes the configured instance the thing agents/workflows use at runtime.

Capabilities should be grouped by how they are used:

- **Tools**: Mastra tools intended for agents during a session.
- **Functions**: deterministic functions intended for workflow steps.
- **Servers**: runtime processes or routes that the preset can instantiate and start/stop.
- **Metadata**: small descriptive/configuration values that help routing, labels, auth checks, or observability.

For example, `github(config)` may register:

```ts
import { githubCapabilities } from "@nearform/mac-github/capabilities";

capabilities.provide(githubCapabilities, {
  tools: {
    createReadTools,
    createReviewTools,
  },
  functions: {
    tokenBroker,
    createOctokit,
    replyOnIssue,
    createStatusPublisher,
    postPullRequestReview,
  },
  servers: {
    createWebhookRoute,
  },
  metadata: {
    managedRepos,
    botLogin,
  },
});
```

Then `workflows({ use: ["pr-review"] })` can require and consume that configured capability. This snippet is **what the `workflows()` extension does internally** when it materializes a selected built-in — it is not the authoring surface. Workflow authors write a `defineWorkflow` *definition* (shown below under "Definitions are constructed by `defineWorkflow` / `defineAgent`"); the extension is what turns a selected definition into a registered workflow inside its `init`:

```ts
import type { GithubCapabilities } from "@nearform/mac-github/capabilities";
import { githubCapabilities } from "@nearform/mac-github/capabilities";
import { agentCapabilities } from "@nearform/mac-agent-workflows/capabilities";

// inside the workflows() extension's init(context):
const github = context.capabilities.require(githubCapabilities);
const agents = context.capabilities.require(agentCapabilities);

return {
  workflows: {
    "pr-review": createPrReviewWorkflow({
      github,
      agents,
      workspaceFactory: context.workspaceFactory,
    }),
  },
};
```

The workflow package may depend on platform type exports and typed capability keys. It should not import concrete platform factories or create platform clients itself. The concrete GitHub implementation arrives from the configured `github(config)` extension.

Recommended registry shape:

```ts
export interface MacCapabilityRegistry {
  provide<T>(key: MacCapabilityKey<T>, value: T): void;
  /** Preflight: is a provider registered for this key? Used to validate before create(). */
  has(key: MacCapabilityKey<unknown>): boolean;
  optional<T>(key: MacCapabilityKey<T>): T | undefined;
  require<T>(key: MacCapabilityKey<T>, message?: string): T;
}

export interface MacCapabilityKey<T> {
  /** Stable, enumerable, printable identifier, e.g. "github". */
  id: string;
  /** Human-facing label used in preflight error messages, e.g. "GitHub platform". */
  description?: string;
  /** Type-only phantom field; no runtime value. */
  readonly type?: T;
}
```

The typed key is the single capability handle. It carries the human metadata needed for operator-facing errors **and** the phantom `T` needed for type-safe retrieval, so there is no second source of truth to keep in sync.

Recommended platform capability shape:

```ts
export interface PlatformCapabilities<
  TTools = Record<string, never>,
  TFunctions = Record<string, never>,
  TServers = Record<string, never>,
  TMetadata = Record<string, never>,
> {
  tools?: TTools;
  functions?: TFunctions;
  servers?: TServers;
  metadata?: TMetadata;
}
```

GitHub can then publish a typed capability contract:

```ts
export interface GithubCapabilities
  extends PlatformCapabilities<
    GithubTools,
    GithubFunctions,
    GithubServers,
    GithubMetadata
  > {}

export interface GithubTools {
  createReadTools(args: { token: string }): GithubReadTools;
  createReviewTools(args: { token: string }): GithubReviewTools;
}

export interface GithubFunctions {
  tokenBroker: GithubTokenBroker;
  createOctokit(args: { token: string }): Octokit;
  replyOnIssue(args: ReplyOnIssueArgs): Promise<void>;
  createStatusPublisher(args: StatusPublisherArgs): StatusPublisher;
  postPullRequestReview(args: PostPullRequestReviewArgs): Promise<PostedReview>;
}

export interface GithubServers {
  /** Same function exported standalone as `createGithubWebhookRoute` (Phase 3); exposed here as a factory for manual composition. */
  createWebhookRoute(args: GithubWebhookRouteArgs): ApiRoute;
}

export interface GithubMetadata {
  managedRepos: string[];
  botLogin: string;
}
```

The grouped `servers` surface is for advanced/manual consumers and for cases where another extension needs a runtime factory. The normal preset path should instantiate platform server surfaces during the platform extension's `init()` and return concrete `apiRoutes` / `runtime` hooks in `MacExtensionResult`. This keeps one obvious lifecycle owner:

- `apiRoutes` are mounted by the Mastra server.
- `runtime.start()` / `runtime.stop()` are called explicitly by the host app.
- `capabilities.servers` contains factories only when another extension or advanced consumer needs to compose server behavior manually.

Slack follows the same pattern:

```ts
export interface SlackCapabilities
  extends PlatformCapabilities<
    SlackTools,
    SlackFunctions,
    SlackServers,
    SlackMetadata
  > {}
```

Typed keys are the main type-safety mechanism. They let the registry return the correct type without callers passing a generic manually:

```ts
export const githubCapabilities =
  capabilityKey<GithubCapabilities>("github");

// `agentCapabilities` is the built-in-typed view of the core `agentRegistryCapability`
// (both share id "agents" and the same registry value) — see "Agent Bundle".
export const agentCapabilities =
  agentRegistryCapability as MacCapabilityKey<MacAgents>;
```

Implementation sketch:

```ts
export function capabilityKey<T>(
  id: string,
  description?: string,
): MacCapabilityKey<T> {
  return { id, description } as MacCapabilityKey<T>;
}
```

Package-level type-safety rules:

- Platform packages export capability interfaces and typed keys from a lightweight path such as `@nearform/mac-github/capabilities`.
- Agent/workflow packages may import those interfaces and keys as type-level contracts.
- Agent/workflow packages must not import platform extension factories, clients, or configuration loaders.
- Use `import type` for interfaces when possible.
- Keep capability export paths dependency-light so type consumers do not pull in Slack Bolt, Octokit runtime code, or env loaders by accident.
- Use package `exports` maps so `/capabilities` is a small, stable public API.

Agents and workflows declare their own capability dependencies as **typed keys**. The app author should not have to repeat those requirements when enabling a workflow.

```ts
export const prReviewWorkflowDefinition = defineWorkflow({
  id: "pr-review",
  description: "Review a GitHub pull request and post the review.",
  requires: [githubCapabilities, agentCapabilities],
  requiredAgents: ["reviewer"],
  // The workspace is not a capability — it arrives as `context.workspaceFactory`
  // (optional; undefined if the app did not configure one). The workflow checks
  // for it rather than declaring a capability key.
  create: ({ capabilities, workspaceFactory }) => {
    const github = capabilities.require(githubCapabilities); // typed GithubCapabilities
    const agents = capabilities.require(agentCapabilities);  // typed agent instances
    return createPrReviewWorkflow({ github, agents, workspaceFactory });
  },
});
```

`requires` lists the **same typed keys** the implementation retrieves with `capabilities.require(...)`. For capability dependencies there is exactly one source of truth: no parallel stringly manifest with `surface`/`uses` granularity to drift out of sync. The earlier draft modelled `uses: ["reviewer"]` as a surface key, but `reviewer` is an agent id inside the bundle, not a capability surface — proof that the granular string manifest was mis-modelled. Drop it. (`requiredAgents` is the one deliberate stringly list that remains, because the host needs the agent ids to auto-enable agents transitively; its drift risk is mitigated by the guarded proxy — see "Transitive agent dependencies".)

`workflows({ use: ["pr-review", "build"] })` selects built-in definitions by name; the host also accepts custom definitions directly (see "Bring Your Own"). For each selected definition the host reads its `requires` keys and validates them against the configured registry before any `create()` runs.

Definitions are constructed by `defineWorkflow` / `defineAgent`:

```ts
export interface MacWorkflowDefinition {
  id: string;
  description: string;
  /** Optional: set to a built-in id to deliberately replace it. */
  overrides?: string;
  requires?: MacCapabilityKey<unknown>[];
  optional?: MacCapabilityKey<unknown>[];
  /** Agent ids this workflow needs from agentCapabilities. */
  requiredAgents?: string[];
  create(context: WorkflowCreateContext): Workflow;
}

export interface MacAgentDefinition {
  id: string;
  description: string;
  overrides?: string;
  requires?: MacCapabilityKey<unknown>[];
  optional?: MacCapabilityKey<unknown>[];
  create(context: AgentCreateContext): Agent;
}
```

Two layers of safety, one source of truth:

- **Preflight by key id at startup**: for each `requires` key the host calls `registry.has(key)`; a miss prints `pr-review requires capability "github" (GitHub platform) which no installed extension provides`. Keys are enumerable and printable, so this is a clean operator error rather than a confusing runtime failure.
- **Type-safe retrieval in implementation code**: `capabilities.require(githubCapabilities)` returns `GithubCapabilities`. A renamed method is a compile error, not a stale string.

Validation rules:

- Missing required capabilities fail preflight (before any workflow runs) with a clear message naming the capability and a hint at which extension to add.
- Optional capabilities degrade gracefully — e.g. chat runs without GitHub tools.
- Enabling a workflow transitively pulls in the agents it requires: the host reads `requiredAgents`, ensures those ids are present in `agentCapabilities`, and can auto-enable built-in agents from the same package when available (see "Transitive agent dependencies" under the agent-workflow package).
- Capability keys are stable public API.
- Capability values are grouped into `tools`, `functions`, `servers`, and `metadata` rather than becoming large flat bags. (This grouping lives on the *value*; dependencies are still expressed with whole-capability keys.)
- Extensions do not reach into another extension's private config.
- Config remains at the app boundary; reusable packages receive configured capability objects.
- Type safety catches mismatched capability shapes at compile time; preflight catches missing configured extensions at startup.

This keeps wiring maintainable:

- Platform extensions know how to configure platform clients.
- Agent extensions know how to create agents from configured `tools` and markdown.
- Workflow extensions know how to assemble workflows from configured `functions`.
- The preset host knows how to instantiate/start configured `servers`.
- The router and observability code can use small `metadata` surfaces without knowing private config.
- The preset host orders, validates, and merges extension outputs.

## Bring Your Own Agents and Workflows

This is the headline goal: a team should be able to add their own workflow or agent — or replace a built-in — quickly, with a typed, dependency-injected API, and **without importing the built-in agent-workflows package** if they don't want the built-ins.

There is one constructor for both built-in and custom definitions: `defineWorkflow` / `defineAgent`. App code imports them from the `@nearform/mac` root; subpackages import them (and the `Mac*Definition` / `MacCapabilityKey` types) from `@nearform/mac/core` to keep the dependency direction one-way. A custom definition is a first-class peer of the built-ins.

Registering a custom workflow — pass the definition straight to the host:

```ts
import { createMacApp, defineWorkflow } from "@nearform/mac";
import { github, githubCapabilities } from "@nearform/mac-github";
import { agents, workflows, agentCapabilities } from "@nearform/mac-agent-workflows";

const release = defineWorkflow({
  id: "release",
  description: "Cut a release once a PR merges.",
  requires: [githubCapabilities, agentCapabilities],
  create: ({ capabilities, workspaceFactory }) => {
    const gh = capabilities.require(githubCapabilities);
    const ag = capabilities.require(agentCapabilities);
    return buildReleaseWorkflow({ gh, agents: ag, workspaceFactory });
  },
});

await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  platforms: [github(githubConfig)],
  agents: [agents({ use: ["reviewer"] })],
  workflows: [workflows({ use: ["pr-review"] }), release], // built-ins + custom, side by side
});
```

A pure-BYO app (no built-ins) simply omits the `agents()`/`workflows()` selectors and lists only its own definitions, so it never has to depend on `@nearform/mac-agent-workflows`. Such a workflow consumes its custom agents through the **core** `agentRegistryCapability` (`capabilities.require(agentRegistryCapability).byId("my-agent")`), not the built-in-typed `agentCapabilities` bundle — see "Agent Bundle". Declare the agent ids it needs in `requiredAgents` so the host preflights them.

**Overriding a built-in is explicit.** Reusing a built-in id is only allowed when the definition opts in with `overrides`; otherwise the host throws on a duplicate id so accidental clobbering is impossible:

```ts
const strictReview = defineWorkflow({
  id: "pr-review",
  overrides: "pr-review",            // intentional replacement; without this the host errors
  requires: [githubCapabilities, agentCapabilities],
  create: ({ capabilities }) => buildStrictReview(capabilities),
});

await createMacApp({
  /* ... */
  workflows: [workflows({ use: ["pr-review"] }), strictReview], // strictReview wins, on purpose
});
```

The same pattern applies to `defineAgent`. To merely tweak a built-in agent's *instructions* (not its structure), prefer the markdown override dir (see "Layered Prompt and Skill Resolution") — that needs no code at all. Reach for `defineAgent({ overrides })` only when the agent's wiring (tools, model, structure) must change.

## Routing and Classification

Routing is the bridge between platform events and runnable capabilities. It lives in the `@nearform/mac` root (the router layer), not inside a platform package and not inside an individual workflow.

Responsibilities:

- Accept normalized `EventEnvelope` objects from platform extensions.
- Apply deterministic route rules first.
- Use a configurable classifier only for ambiguous human text, such as Slack chat messages or GitHub comments that mention the bot.
- Return a `RoutingResult`: run a workflow, run an agent, reply directly, or ignore.
- Preserve safety gates such as maintainer-only GitHub build triggers and managed-repo filtering.

Platform packages should normalize events only. They should not decide that a Slack message means "run build" or that a GitHub comment means "run PR fix". They pass events into `dispatch`.

Agent and workflow extensions only **contribute defaults** — they do not own override config. `agents()` contributes a default route target for `chat`; `workflows()` contributes default targets for `pr-review`, `github-orchestrator`, and later `issue-triage`, `security-review`, etc. Either can contribute default classifier intents such as `BUILD`, `REVIEW`, `TRIAGE`, and `CHAT`. **All overrides live in one place: the host `routing` block.** This avoids the doc's earlier split where routing could be configured both on `createMacApp` and on `workflows()`.

The top-level `createMacApp(...)` host assembles the router from:

- Built-in default routes.
- Default route/intent contributions from extensions.
- User-provided target overrides (on the host).
- User-provided custom routes (on the host).
- User-provided classifier overrides or extra intents (on the host).

Example — one override shape (`overrideTargets`), one key scheme: `<source>.<event-or-intent>`, the same `_routeKey` the router already stamps today. For deterministic events the suffix is the event (`github.pr_opened`); for ambiguous human text the suffix is the **classified intent** the router resolved (`slack.build`, `github.pr_fix`). So `slack.deploy` below overrides the route for a Slack message *classified as `deploy`*:

```ts
const mac = await createMacApp({
  model,
  workspaceFactory,
  platforms: [github(githubConfig), slack(slackConfig)],
  agents: [agents()],
  workflows: [workflows()],
  routing: {
    includeDefaults: true,
    overrideTargets: {
      "github.pr_opened": { type: "workflow", id: "my-pr-review" },
      "slack.deploy": { type: "workflow", id: "release-orchestrator" },
    },
    add: [
      {
        id: "linear-build",
        when: ({ envelope }) =>
          envelope.source === "linear" && envelope.type === "issue.opened",
        target: { type: "workflow", id: "build" },
      },
    ],
    classifier: {
      extraIntents: [
        {
          id: "DEPLOY",
          description: "User wants to deploy or release a change.",
          target: { type: "workflow", id: "release-orchestrator" },
        },
      ],
    },
  },
});
```

Recommended route contribution shape:

```ts
export type MacRouteTarget =
  | { type: "workflow"; id: string; input?: (ctx: RouteContext) => Record<string, unknown> }
  | { type: "agent"; id: string; input?: (ctx: RouteContext) => string | Record<string, unknown> }
  | { type: "reply"; message: string | ((ctx: RouteContext) => string) }
  | { type: "ignore"; reason: string };

export interface MacRouteContribution {
  id: string;
  source?: string;
  eventTypes?: EventType[];
  priority?: number;
  when?: (ctx: RouteContext) => boolean | Promise<boolean>;
  target: MacRouteTarget;
}

export interface MacClassifierIntent {
  id: string;
  description: string;
  examples?: string[];
  requires?: {
    repo?: boolean;
    issueNumber?: boolean;
    maintainer?: boolean;
  };
  target: MacRouteTarget;
}
```

The host-level `routing` block (the `MacRoutingConfig` referenced by `MacAppConfig`) is the single place overrides live:

```ts
export interface MacRoutingConfig {
  /** Include the built-in default route table. Defaults to true. */
  includeDefaults?: boolean;
  /** Override the target for a `<source>.<event-or-intent>` route key. */
  overrideTargets?: Record<string, MacRouteTarget>;
  /** Additional custom routes, appended after defaults and extension contributions. */
  add?: MacRouteContribution[];
  classifier?: {
    extraIntents?: MacClassifierIntent[];
  };
}
```

Default routing stays easy to enable — it is on by default and lives in one place:

```ts
createMacApp({ /* ... */, routing: { includeDefaults: true } });
```

Adding or replacing behavior uses the same host block (`add`, `overrideTargets`) shown above. The `workflows()` / `agents()` extensions never take a `routes` option — they only return default `MacRouteContribution[]`. One override surface, one key scheme, no duplication.

The host preflights every route target against the final registries before `runtime.start()`:

- `{ type: "workflow", id }` must match a registered workflow id.
- `{ type: "agent", id }` must match a registered agent id.
- Overrides that point at unknown ids fail at startup.
- Default extension routes are validated the same way, so a broken built-in contribution is caught before the first GitHub or Slack event.
- The same check covers `MacClassifierIntent.target`, so an intent (built-in or from `extraIntents`) that points at an unregistered workflow/agent also fails at startup, not on the first classified message.

Classifier configuration belongs to the router because it chooses intent. The agent-workflow package supplies default intents for its built-in capabilities; users add intents via `routing.classifier.extraIntents` without editing any prompt body.

**Caveat — extra intents need a data-driven classifier.** Today the classifier (`engine/classifier.ts` + the `switch` in `engine/router.ts`) is a hand-written prompt over a *closed* intent enum. `extraIntents` only takes effect if the classifier prompt is **assembled from the merged intent catalogue** (each intent's `description`/`examples`) rather than hardcoded. Making the classifier prompt data-driven is its own work item — until it lands, `extraIntents` is inert. This is called out explicitly so "bring your own intent" is not mistaken for a free feature of the current classifier.

The same dependency applies to **intent-keyed `overrideTargets`**. An override on a deterministic event key (`github.pr_opened`) works today. An override on a *new* intent key (`slack.deploy`) only fires once the classifier can actually emit that intent — i.e. after the data-driven-classifier work lands. Overrides on intents the current classifier already produces (`slack.build`, `github.pr_fix`) work now.

In practical terms:

- GitHub extension: creates webhook routes and emits GitHub event envelopes.
- Slack extension: starts Socket Mode and emits Slack message envelopes.
- Agent extension: registers agents and contributes agent route targets/intents.
- Workflow extension: registers workflows and contributes workflow route targets/intents.
- Top-level router: chooses the target for each event using defaults, extension contributions, and user overrides.

## Dependency Injection Contracts

Reusable packages should prefer explicit dependencies over process-wide config.

### GitHub Token Broker

```ts
export interface GithubTokenBroker {
  mint(profile: GitAccessProfile): Promise<{
    token: string;
    expiresAt: string;
  }>;
}
```

The broker is the *only* way package workflow code obtains a token. Today `workflows/pr-review.ts` reads `githubAppConfigFromEnv()` **inside the step** and mints its own token via `mintTokenForProfile(appConfig, profile)`. The factory migration must replace that with `github.functions.tokenBroker.mint(profile)`, supplied by the configured `github()` extension — no env read, no app-config knowledge inside the workflow. This is what makes the workflow reusable across apps that configure GitHub differently.

### GitHub Capability Bundle

`GithubCapabilities` uses the grouped platform capability shape described above: `tools`, `functions`, `servers`, and `metadata`. Agent code normally consumes `github.tools`; workflow code normally consumes `github.functions`. The host normally gets server surfaces as concrete `apiRoutes` / `runtime` hooks from the platform extension's `MacExtensionResult` — `github.servers` holds factory forms only for advanced/manual composition (see the `servers` lifecycle note under "Capability Wiring").

### Agent Bundle (registered instances)

There are two layers here, and the split is what makes **bring-your-own agents** work:

1. **A core-owned agent registry capability** — `agentRegistryCapability` (key id `"agents"`), defined in `@nearform/mac/core`. Its value exposes every registered agent by id, including custom `defineAgent` agents. This is the capability a *custom* workflow consumes, and it exists even in a pure-BYO app that does not depend on `@nearform/mac-agent-workflows`.

   ```ts
   export interface MacAgentRegistry {
     /** Any registered agent (built-in or custom) by id; throws a clear error if absent. */
     byId(id: string): Agent;
     /** Non-throwing lookup. */
     find(id: string): Agent | undefined;
     ids(): string[];
   }

   export const agentRegistryCapability = capabilityKey<MacAgentRegistry>("agents");
   ```

2. **A typed convenience bundle for the built-ins** — `MacAgents`, exported from `@nearform/mac-agent-workflows`, layered *on top of* the registry so built-in workflows get compile-time names without a string lookup:

   ```ts
   export interface MacAgents extends MacAgentRegistry {
     chat: Agent;
     reviewer: Agent;
     buildReviewer: Agent;
     guardrails: Agent;
     architect: Agent;
     executor: Agent;
     fix: Agent;
   }

   // Same id "agents" as the core key, narrowed to the built-in bundle for typed access.
   export const agentCapabilities = agentRegistryCapability as MacCapabilityKey<MacAgents>;
   ```

Both keys share the **same registry value and the same `"agents"` id** — `agentCapabilities` is just the built-in-typed view of `agentRegistryCapability`. A built-in workflow uses `agents.reviewer` (typed); a custom workflow consuming a custom agent uses `capabilities.require(agentRegistryCapability).byId("my-agent")`. The host populates the one registry from *all* registered agents (built-in selectors + custom `defineAgent`), so neither path can see an agent the host did not register.

Whichever view a workflow consumes, the value is **constructed, registered `Agent` instances**, never `create*` factories.

Why instances, not factories — **this is a correctness requirement, not a style choice.** Today `apps/maintenance/src/mastra/index.ts` registers every build agent in the `Mastra` instance specifically so the observability exporter wires in, and workflows fetch the *registered* instance via `mastra.getAgent("reviewer")` (`workflows/pr-review.ts`). If a workflow instead called a `createReviewAgent()` factory inline, it would get an **unregistered** agent with no exporter attached — silently losing the Studio traces (notably the sandbox `execute_command` spans) that the registration exists to capture.

So the `agents()` extension:

- Constructs each selected agent **once**, using the layered prompt loader for its instructions.
- Registers those instances into `mac.agents` (which flows to `new Mastra({ agents })`).
- Publishes the **same instances** into the registry under `agentCapabilities`.

Per-run state (taskId, scoped token) does not require per-run construction — it already flows through `requestContext` and the existing dynamic `tools`/`workspace` resolvers (`apps/maintenance/src/mastra/agents/runtime.ts`). The `create*Agent(...)` factories still exist *inside* the package (used by `agents()` to build the instances and overridable via `defineAgent`), but they are not the workflow-facing surface. Per-agent model overrides can be supplied to `agents({ use, models })` at selection time.

Make this an explicit package API so workflow authors do not recreate the current ad hoc context helpers differently:

```ts
export interface MacAgentRunContext {
  taskId: string;
  token?: string;
  workspace?: Workspace;
}

export function buildAgentRequestContext(ctx: MacAgentRunContext): RequestContext;
```

Registered coding agents must resolve per-run tools and workspace from this request context, not from constructor arguments. Workflow steps pass a fresh request context to `agent.generate(...)`; the agent instance stays stable and registered while the run-specific token/workspace changes per invocation.

### Workspace Factory

Coding agents need an isolated working area where they can inspect repositories, edit files, and run shell commands through Mastra workspace tools. A workspace factory is the app-provided function that creates that working area for each task or run.

```ts
export interface WorkspaceFactory {
  create(taskId: string, options?: { token?: string }): Workspace;
}
```

In the current app this maps to `createCodeWorkspace(taskId)`, which creates a Mastra `Workspace` backed by `LocalFilesystem` and `LocalSandbox`. In a reusable package, workflows should not assume that local host sandbox. A consumer may provide:

- A local filesystem/sandbox workspace for development.
- A remote sandbox workspace for production.
- A locked-down container workspace.
- A no-op or read-only workspace for workflows that do not execute code.

The `taskId` gives each run a separate checkout directory. Optional values such as a short-lived GitHub token let the app pass scoped credentials into the workspace without exposing provider API keys.

### Approval Link Builder

```ts
export interface ApprovalLinkBuilder {
  link(runId: string, decision: "approve" | "reject"): string;
}
```

### Dispatch Function

```ts
export type DispatchFn = (envelope: EventEnvelope) => Promise<unknown>;
```

Connectors depend on this function, not on a concrete Mastra app.

### Known limitation: `EventEnvelope.reply()` is not serializable (deferred)

The current `EventEnvelope` (`apps/maintenance/src/mastra/connectors/types.ts`) carries a `reply(msg)` **closure** plus a `raw: unknown` payload. This is pragmatic and works today, and this refactor **keeps it** — event durability/queueing is not a near-term goal.

Recording the trade-off so the decision is traceable:

- A closure cannot be put on a queue, persisted in a DB row, or captured in a workflow suspend/resume snapshot. So this envelope shape blocks durable, cross-restart event handling.
- The codebase already works around it: `engine/dispatch.ts` re-derives Slack coordinates from `envelope.raw` (`slackOrigin`) because the closure cannot cross the workflow boundary, and `workflows/pr-review.ts` re-posts to Slack from those re-derived coordinates.
- **Future direction (out of scope now):** replace `reply` + `raw` with a serializable `ReplyTarget` discriminated union (e.g. `{ kind: "github-issue"; repo; number } | { kind: "slack-thread"; channel; ts }`) and move the act of replying to a capability function on each platform extension (`github.functions.replyOnIssue`, `slack.functions.postMessage` — both already exist in the capability lists). That makes envelopes plain data: serializable, queueable, snapshot-safe.

Revisit this only if/when persisting or queuing events (or durable suspend/resume across restarts) becomes a goal.

## Preset Output

`createMacApp(...)` should initialize extensions and return plain registries that can be spread into a Mastra instance.

```ts
export interface MacPreset {
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  apiRoutes: ApiRoute[];
  mcpServers: Record<string, MCPServer>;
  runtime?: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}
```

The `runtime` object is for long-running pieces such as Slack Socket Mode. It must not start automatically during module import.

## MCP Strategy

The top-level preset can optionally register an MCP server that exposes selected MAC capabilities.

Initial MCP surface:

- GitHub read tools.
- PR review workflow.
- Chat agent, once it has a useful description.

Later MCP surface:

- Build workflow, only when approval, write permissions, and status publishing are configured.
- Repo health workflow.
- Issue triage workflow.

Rules:

- MCP-exposed agents and workflows must have non-empty descriptions.
- Write tools require explicit opt-in.
- Build/write workflows should default to human approval enabled.

## Refactor Phases

This refactor should be executed as a sequence of small, resumable checkpoints.
The purpose of the phases is context control and completion certainty, not
guaranteeing that the whole reference app is runnable after every stop. Some
phases are integration checkpoints; others are package-construction checkpoints
that may leave the app between wiring states on purpose.

Every phase must still end in a **known state**:

- The phase's intended artifact is complete.
- Verification for that artifact has been run and recorded.
- Any intentionally broken integration point is named explicitly.
- The next phase has a clear entry condition.
- There is no ambiguous split ownership where future work would have to rediscover
  which copy of a behavior is authoritative.

Recommended working rules for every phase:

- Start from a named branch or checkpoint commit.
- Keep one behavior boundary in focus: contracts, GitHub, Slack, agents, workflows,
  host composition, or docs/examples.
- Add tests before moving code when behavior is currently implicit.
- Prefer compatibility shims over import rewrites that must land all at once.
- Do not delete the old in-app implementation until the phase intentionally owns
  the replacement path and has recorded how the app will be reconnected.
- Stop only at a phase boundary or explicitly marked context checkpoint.

Phase acceptance should be treated as a gate, not a suggestion. If a phase fails
its gate, finish by documenting the blocker, the partial state, and the exact next
action. Do not let "almost done" become hidden context debt for the next session.

Acceptance checks should be scoped to the phase. For integration phases that means
`apps/maintenance` typechecks and behavior is unchanged. For construction phases it
may mean package typecheck, export-map validation, dependency-cycle checks, golden
snapshots, or a written wiring inventory, with the app integration deferred to a
later named phase.

### Execution Track

The numbered phases below remain the source of truth, but this is the practical
order to run them in across sessions:

1. **Safety net and contracts:** Phase 0, then Phase 2 core contracts.
2. **Platform extraction:** Phase 1 GitHub rename/hardening, Phase 3 GitHub
   connector exports, then Phase 4 Slack extraction.
3. **Instruction externalization:** Phase 5a only. This deliberately happens
   before package movement so prompt behavior can be proven byte-for-byte.
4. **Agent/workflow relocation:** Phase 5b, completing the package artifact first
   and adding compatibility wrappers only if this phase is also chosen as an
   integration checkpoint.
5. **Host composition:** Phase 6, with `apps/maintenance` converted into a thin
   consumer only after package outputs are stable.
6. **Workflow factory conversion:** Phase 7 PR review, then Phase 8 build.
7. **External surfaces and release readiness:** Phase 9 MCP, then Phase 10 docs,
   examples, exports, and dependency-cycle checks.

The tempting shortcut is to convert `pr-review` immediately after extracting core
types. Do not do that. It crosses too many boundaries at once: registered-agent
injection, prompt loading, GitHub capabilities, workspace injection, and host
composition. Keep `pr-review` factory conversion as the first proof of the complete
package model, not as the first package extraction step.

### Phase 0: Freeze Contracts

Goal: document and stabilize the contracts before moving code.

Tasks:

- Keep this design doc current as the source of package-boundary truth.
- Add package-boundary notes to `MIGRATION.md`.
- Add tests around current event normalization and router behavior before extraction.
- Record current Mastra API signatures that package factories rely on.
- Record current package imports and public exports so rename shims can be checked
  deliberately.
- Snapshot current agent instruction composition for every inlined agent before
  Phase 5a. These snapshots may live as pending/golden tests until Phase 5a, but
  the baseline should be captured before any prompt edits.

Acceptance checks:

- `pnpm -C apps/maintenance typecheck` passes.
- Existing webhook, Slack, PR review, and build behavior are unchanged.
- Tests cover `EventEnvelope` normalization and route decisions.
- There is a written inventory of the current runtime boundaries:
  GitHub auth/tools, GitHub webhook, Slack connector, router/dispatch, agents,
  workflows, workspace, approval route, and server boot.

Context checkpoint:

- Phase is complete when no package boundaries have moved yet; later sessions can start
  from test coverage and the inventory.

### Phase 1: Rename and Harden GitHub Package

Goal: turn the existing `packages/github` package into `@nearform/mac-github`, starting with tool/auth exports.

Tasks:

- Rename package metadata from `@lastlight/github` to `@nearform/mac-github`.
- Update imports in `apps/maintenance` in one pass, or provide a temporary
  `@lastlight/github` compatibility package/alias if that keeps the diff smaller.
- Keep exports backward-compatible where practical during the transition.
- Separate read tool factories from write helper factories in the public API.
- Keep token profiles and token minting in this package.
- Export tools and auth from the root; publish the type-only `GithubCapabilities`/`githubCapabilities` on `/capabilities`.
- Add `github(config)` as the root export.
- Add package-level README with examples.

Acceptance checks:

- App typecheck passes.
- PR review workflow can still mint `review-write` and post a review.
- Chat agent can still attach read-only GitHub tools when configured.

Context checkpoint:

- Phase is complete when the app imports only the new package name or an explicit
  compatibility alias. Do not continue if both names are used accidentally.

### Phase 2: Extract Top-Level Core Contracts

Goal: move event contracts and routing primitives into the dependency-light core layer of `@nearform/mac`, **and** establish the extension/capability/authoring contracts that later phases (5b, 6) consume. Without these contracts in core first, `agents()`/`workflows()` in Phase 5b have nothing to implement against.

Tasks:

- Create `packages/mac`.
- Move `EventEnvelope` and `EventType`. Do **not** move the unused `EventEmitter`-based `Connector`; the system uses `DispatchFn` + `runtime.start()/stop()`. Drop it (or replace with the runtime-hook shape) rather than promoting dead code to public API.
- Move route config types and default route table.
- Move `RoutingResult` and router interfaces.
- Move deterministic router logic.
- Decide whether classifier/screener implementations live in core immediately or are injected behind interfaces first.
- Add route contribution and classifier intent types (`MacRouteTarget`, `MacRouteContribution`, `MacClassifierIntent`, `MacRoutingConfig`).
- **Add the extension and capability contracts:** `MacExtension`, `MacExtensionContext`, `MacExtensionResult`, the `MacCapabilityRegistry` interface, `MacCapabilityKey<T>`, and `capabilityKey()`.
- **Add the authoring helpers and definition types:** `defineAgent`, `defineWorkflow`, `MacAgentDefinition`, `MacWorkflowDefinition`, and the core `agentRegistryCapability` / `MacAgentRegistry` (so a BYO workflow can resolve agents without depending on `@nearform/mac-agent-workflows`).
- Add support for merging default routes, extension routes, user overrides, and custom routes.
- Export core contracts and authoring helpers from `@nearform/mac/core`; re-export the authoring helpers from the root.
- Update GitHub and Slack code to import event types and capability contracts from `@nearform/mac/core`.

Acceptance checks:

- Router behavior matches pre-extraction tests.
- No GitHub or Slack SDK dependencies enter the core layer.
- `@nearform/mac/core` has no dependency on the preset root or any platform/agent package (it is the sink of the dependency graph).
- App typecheck passes.

Context checkpoint:

- Phase is complete when app behavior still runs through existing in-app server and
  workflow code, but shared event/router/capability types come from
  `@nearform/mac/core`.

### Phase 3: Add GitHub Connector Exports

Goal: package the GitHub webhook path as reusable connector exports inside `@nearform/mac-github`.

Tasks:

- Add connector exports from the `@nearform/mac-github` root (no separate `/connector` subpath unless a consumer proves it needs the connector without the rest).
- Move signature verification and GitHub payload normalization.
- Move bot filtering and ignored-action rules.
- Replace `githubWebhookRoute` constant with `createGithubWebhookRoute(options)`.
- Inject managed-repo checks.
- Inject reply/comment publisher.
- Inject dispatch function or dispatch factory.
- Update `github(config)` to include webhook routes and GitHub capabilities.

Target API:

```ts
const githubWebhookRoute = createGithubWebhookRoute({
  webhookSecret,
  botLogin,
  isManagedRepo,
  replyOnIssue,
  dispatch,
});
```

Acceptance checks:

- Webhook route still returns fast `202` after accepted events.
- Unmanaged repos are filtered.
- Bot self-events are filtered except PR attention events.
- App typecheck passes.

Context checkpoint:

- Phase is complete when `apps/maintenance` either uses the packaged webhook route or
  an in-app shim that delegates to it. Avoid keeping two independent webhook
  normalizers.

### Phase 4: Extract Slack Package

Goal: create `@nearform/mac-slack` with separate tool and connector exports.

Tasks:

- Create `packages/mac-slack`.
- Move `markdownToSlackMrkdwn`.
- Extract message posting, chunking, status, and user lookup helpers where useful.
- Export Slack tools and the Socket Mode connector from the `@nearform/mac-slack` root; publish the type-only `SlackCapabilities`/`slackCapabilities` on `/capabilities`.
- Add `slack(config)` as the root export.
- Move Socket Mode connector.
- Make connector accept tools/helpers instead of embedding all Web API behavior.
- Keep runtime start/stop explicit.

Target API:

```ts
const slack = createSlackConnector({
  config,
  dispatch,
  tools: createSlackTools(config),
});

await slack.start();
```

Acceptance checks:

- Slack remains disabled when required tokens are absent.
- Slack messages normalize to `EventEnvelope`.
- Thread continuation behavior remains unchanged.
- App typecheck passes.

Context checkpoint:

- Phase is complete when Slack Socket Mode start/stop remains explicit in
  `apps/maintenance/src/server.ts` and the connector code has exactly one owner.

### Phase 5a: Externalize inline agent instructions to markdown (behavior-preserving, in-app)

Goal: move the *currently inlined* instruction strings into markdown behind a loader, **without changing what any agent sees**. This is the risky part and is isolated so a behavior change can't hide among packaging churn. It happens in-app, before any package move.

Important: the root `/prompts/*.md` and `/skills/**` directories **are not used today** — every agent inlines its instructions and only `/agent-context/*.md` is read at runtime. Do **not** adopt that dormant content as-is; it was never validated against the live agents and may not match. Externalize only what is actually inlined now.

Tasks:

- Add a layered prompt/skill/context loader (`PromptResolver`) in the app, resolving `overrideDir/<key>.md` → default, defaults via `import.meta.url` (not cwd guessing).
- For each agent, extract its inlined instruction string into a markdown file whose composed output is **byte-for-byte identical** to today's `persona() + [...].join(...)`.
- Add **golden-output tests** asserting each agent's final composed instruction string equals a snapshot of the current output.

Acceptance checks:

- Golden tests pass: every agent's composed instructions are identical to before.
- Only currently-inlined content was externalized; dormant `/prompts`/`/skills` content was not silently activated.
- App typecheck passes; existing behavior unchanged.

Context checkpoint:

- Phase is complete when the app still runs entirely in-place, but prompt content is
  now markdown-backed and protected by golden tests.

### Phase 5b: Extract Agent-Workflow Package and Markdown Assets (mechanical move)

Goal: make `@nearform/mac-agent-workflows` the single home for agents, workflow factories, prompts, skills, and agent context. With instructions already in markdown (5a), this is a relocation with no content change — the 5a golden tests carry over unchanged.

Tasks:

- Create `packages/mac-agent-workflows`.
- Move agent factories (kept package-internal; `agents()` builds registered instances from them).
- Move workflow files into the package, initially re-exporting compatible workflow constants or thin factory wrappers.
- Move the now-markdown `prompts/`, `skills/`, and `agent-context/` assets into the package; re-point the loader's package-default path to resolve via `import.meta.url`.
- Add structured parsers for agent output contracts.
- Contribute default route targets and classifier intents for built-in agents and workflows.
- Add `agents({ use })` to select+register agents as instances and publish `agentCapabilities`.
- Add `workflows({ use })` to select+register workflows and contribute default routes.

Target file layout:

```txt
packages/mac-agent-workflows/
  src/
    index.ts
    agents/
    workflows/
    loaders/
    parsers/
  prompts/
  skills/
  agent-context/
```

Acceptance checks:

- 5a golden tests still pass after the move (no content change).
- No workflow file owns markdown instructions.
- Existing agents can be created from the package; chat, review, guardrails, architect, executor, and fixer prompts resolve from markdown.
- App typecheck passes.

Context checkpoint:

- Phase is complete when `apps/maintenance` can still register the same agents and
  workflows through compatibility imports from `@nearform/mac-agent-workflows`.
  Do not require `createMacApp(...)` yet.

### Phase 6: Add Top-Level Extension Host

Goal: make installation into a default Mastra app straightforward and give later workflow factories a real capability registry to consume.

Tasks:

- Implement `createMacApp(options)` in `@nearform/mac`.
- Accept grouped `platforms`, `agents`, and `workflows` inputs, normalizing extensions and custom definitions into one init path.
- Initialize extensions with shared context, dispatch, workspace factory, and a capability registry.
- Build a dependency graph from `provides`/`requires`, run extension init in topological order, and detect cycles.
- Build the router from defaults, extension route contributions, user overrides, custom routes, and classifier intents.
- Preflight route targets against the final registered agent/workflow ids before runtime starts.
- Merge extension results into final agents, workflows, routes, MCP servers, and runtime hooks. (Capabilities are not in the result — they were published into the shared registry imperatively during each extension's `init`.)
- Return `agents`, `workflows`, `apiRoutes`, optional `mcpServers`, and optional runtime start/stop.
- Keep `apps/maintenance` as a thin consumer of the preset.

Acceptance checks:

- `apps/maintenance/src/mastra/index.ts` mostly composes preset output.
- `apps/maintenance/src/server.ts` starts only runtime connectors and the Hono/Mastra server.
- A sample Mastra entry can register MAC with extensions in under 50 lines.
- App typecheck passes.

Context checkpoint:

- Phase is complete when the preset can compose packages, but before converting any
  workflow internals to new dependency-injected factories. This keeps host
  composition separate from workflow behavior changes.

### Phase 7: Convert PR Review Workflow to a Factory

Goal: prove the workflow factory pattern with the smallest production workflow.

Tasks:

- Convert `pr-review` inside `@nearform/mac-agent-workflows` into a `createPrReviewWorkflow(deps)` factory.
- Consume configured GitHub capabilities from the capability registry.
- Resolve the reviewer from the injected **registered agent instance** (`agents.reviewer`), not a fresh factory — preserves observability tracing.
- Mint tokens via the injected `github.functions.tokenBroker`. Remove the in-step `githubAppConfigFromEnv()` + `mintTokenForProfile(...)` calls.
- Inject workspace factory.
- Keep posting deterministic from the workflow after the reviewer emits a verdict.
- Add a description suitable for MCP exposure.

Target API:

```ts
const prReviewWorkflow = createPrReviewWorkflow({
  github,
  agents,
  workspaceFactory,
});
```

Acceptance checks:

- Existing `pr-review` workflow behavior is unchanged.
- Workflow contains no prompt or skill bodies.
- **No `process.env` reads and no `*FromEnv` calls inside the package workflow/agent code** (grep the package; this catches the env read that the "can still mint review-write" check alone would miss).
- The reviewer agent's spans still appear in observability (the injected instance is the registered one).
- Workflow can be registered under the current key `"pr-review"`.
- App typecheck passes.

Context checkpoint:

- Phase is complete when PR review is the only workflow fully converted to the new
  factory/capability model and build still follows the previous compatible path.

### Phase 8: Convert Build Workflow to a Factory

Goal: extract the larger build workflow without losing current GitHub-centric behavior.

Tasks:

- Convert `build` workflow inside `@nearform/mac-agent-workflows` into a `createBuildWorkflow(deps)` factory.
- Resolve build agents from injected **registered agent instances**, not fresh factories.
- Use configured GitHub capabilities from the capability registry, including `github.functions.tokenBroker` and write helpers.
- Use the injected workspace factory.
- Inject approval link builder.
- Inject status/comment publisher.
- Keep Git and workspace helpers either in workflow modules or move shared helpers to the top-level core layer or agent-workflow package as appropriate.
- Remove direct env reads from workflow code.
- Keep approval suspend/resume semantics.

Acceptance checks:

- Build workflow starts from issue input.
- Guardrails, architect, approval, executor, review/fix loop, and PR creation still run.
- Approval links still resume the correct run.
- Workflow contains no skill or prompt bodies.
- **No `process.env` reads and no `*FromEnv` calls inside the package workflow/agent code** (grep the package).
- Build agents resolved from injected registered instances still emit observability spans (notably sandbox `execute_command`).
- App typecheck passes.

Context checkpoint:

- Phase is complete when both production workflows are factory-backed and
  `apps/maintenance` is thin composition plus local config/server boot.

### Phase 9: Add MCP Export

Goal: expose selected MAC capabilities beyond embedded Mastra apps.

Tasks:

- Add optional MCP server creation in `@nearform/mac`.
- Expose safe read tools by default.
- Expose PR review workflow when configured.
- Expose build workflow only with explicit write and approval configuration.
- Add descriptions to all MCP-exposed agents/workflows.

Acceptance checks:

- MCP server registers with a Mastra instance.
- Tool list includes expected GitHub read tools.
- PR review appears as a runnable workflow tool.
- Write/build capabilities are absent unless explicitly enabled.

Context checkpoint:

- Phase is complete when MCP remains an optional surface. The embedded app path must not
  depend on MCP being enabled.

### Phase 10: Publish Readiness

Goal: prepare packages for external consumption.

Tasks:

- Add package READMEs.
- Add examples:
  - minimal GitHub PR reviewer
  - GitHub webhook app
  - Slack chat connector
  - full MAC preset
- Add API reference snippets.
- Add package exports maps.
- Add changelog policy.
- Decide whether old `@lastlight/github` remains as a compatibility package or is fully replaced.

Acceptance checks:

- Each package can be imported independently.
- No package has accidental dependency cycles.
- Fresh install example typechecks.
- Reference app still runs.

Context checkpoint:

- Release candidate. Remaining work should be documentation, compatibility policy,
  and package publishing mechanics rather than architecture changes.

## Migration Safety Rules

- Keep `apps/maintenance` working at explicitly named integration checkpoints, not
  necessarily after every package-construction phase.
- When a phase intentionally leaves the app between wiring states, record the
  broken imports/routes/registrations and the next phase that will reconnect them.
- Prefer moving one package boundary at a time.
- Use adapter shims during transitions instead of big-bang import changes.
- Do not change runtime behavior while moving code unless the phase explicitly says so.
- Keep generated package APIs boring and explicit.
- Avoid reading `process.env` from reusable package internals except in explicitly named `fromEnv` helpers.
- Do not start network listeners or Socket Mode clients at module import time.
- Preserve the current GitHub permission-profile discipline.

## Open Questions

- Should `classifier.ts`, `screen.ts`, and `llm.ts` live in the dependency-light core layer, or should core define interfaces while the preset layer wires default implementations?
- Should Git helpers such as clone, branch, diff, commit, and push live in `@nearform/mac-agent-workflows`, `@nearform/mac-github`, or a future `@nearform/mac-git` package?
- Should skills be published only inside `@nearform/mac-agent-workflows`, or should there also be a separate consumable skill bundle later?
- How much backward compatibility should `@lastlight/github` retain once `@nearform/mac-github` exists?
- Which workflows are safe enough to expose via MCP by default?
- When (not whether) to make the classifier prompt data-driven so `routing.classifier.extraIntents` becomes live. Its own work item; tracked under "Routing and Classification".

Resolved during this revision (recorded so they are not re-litigated):

- **Capability wiring:** single typed-key mechanism (`requires: CapabilityKey[]` + `registry.has()`), not a parallel string manifest with surface/uses granularity.
- **Host config shape:** grouped `platforms` / `agents` / `workflows` keys with topological init ordering; not an order-sensitive flat `extensions` array.
- **Routing:** one override surface on the host (`routing.overrideTargets`, `<source>.<event>` keys); extensions only contribute defaults.
- **Agent injection:** workflows consume registered agent **instances**, never `create*` factories (observability requirement).
- **Prompt overrides:** layered loader (app `overrideDir` → package default via `import.meta.url`).
- **Subpath exports:** start at root + dep-light `/core` (and `/capabilities` per platform); collapse namespace-only subpaths.
- **`EventEnvelope.reply()` closure:** kept for now; durability/`ReplyTarget` deferred (see "Known limitation").

## First Execution Slice

The lowest-risk first slice is deliberately smaller than the full package proof:

1. Complete Phase 0: tests, boundary inventory, and current API notes.
2. Complete Phase 2's core-contract subset needed by existing code:
   `EventEnvelope`, `EventType`, `DispatchFn`, route types, router result types,
   capability keys, and authoring definition types.
3. Complete Phase 1's GitHub rename/hardening, keeping behavior unchanged.

That slice proves the dependency direction and package naming without moving
agents, prompts, workflows, or Slack runtime lifecycle. The next session can then
choose either GitHub connector extraction (Phase 3) or prompt externalization
(Phase 5a), depending on which risk we want to retire first.
