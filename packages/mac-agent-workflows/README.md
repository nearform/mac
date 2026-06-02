# @nearform/mac-agent-workflows

Reusable **MAC** (Mastra Agentic Coding) agents, workflow factories, and all
markdown instruction assets. This is the single home for the built-in chat /
reviewer / architect / executor / fixer / guardrails agents and the PR-review and
build workflows, plus the prompts and agent-context that instruct them.

The working rule: **workflows orchestrate, agents decide, markdown instructs.**

## Entry points

| Import | Contents | Weight |
| --- | --- | --- |
| `@nearform/mac-agent-workflows` | `agents({ use })`, `workflows({ use })`, the workflow definitions + factories, prompt/context loaders, output parsers, `MacAgents`/`agentCapabilities` — the full API. | pulls `@mastra/core` + ships markdown assets |
| `@nearform/mac-agent-workflows/capabilities` | `MacAgents` + the `agentCapabilities` key (the built-in-typed view of the core `agentRegistryCapability`). | dependency-light type contract |

This package consumes platform capabilities **by injection**, not by importing
platform runtimes: its only edge to `@nearform/mac-github` / `@nearform/mac-slack`
is the dependency-light `/capabilities` surface (the `import type` of
`GithubCapabilities`/`SlackCapabilities` plus the `githubCapabilities`/
`slackCapabilities` keys). No Octokit, no Bolt is pulled at import. The configured
platform implementations arrive at runtime through the capability registry.

## `agents({ use })`

Selects and constructs built-in agents **once**, returning the instances for the
host to register (so workflows consume registered, observability-traced instances
rather than fresh duplicates):

```ts
import { agents } from "@nearform/mac-agent-workflows";

const bundle = agents({
  use: ["chat", "reviewer", "architect", "executor"],
  models: { architect: "anthropic/claude-opus-4-8" }, // optional per-agent override
});
// createMacApp({ agents: [bundle] })
```

Built-in agent ids: `chat`, `reviewer`, `build-reviewer`, `architect`,
`executor`, `fix`, `guardrails`. The `agents()` extension `requires` the GitHub
read-tools capability and the host workspace factory; it contributes the default
`chat` route and a `CHAT` classifier intent.

## `workflows({ use })`

Returns the selected built-in workflow **definitions** for the host to register:

```ts
import {
  workflows,
  prReviewWorkflowDefinition,
  buildWorkflowDefinition,
} from "@nearform/mac-agent-workflows";

createMacApp({ workflows: [workflows({ use: ["pr-review", "build"] })] });
// equivalently, pass the definitions directly:
createMacApp({ workflows: [prReviewWorkflowDefinition, buildWorkflowDefinition] });
```

Built-in workflow ids: `pr-review`, `build`. Each definition declares its own
`requires` (e.g. `githubCapabilities`, `agentCapabilities`) and `requiredAgents`,
so the host preflights capabilities **and preflights that each required agent is
registered** — throwing early if not. The host does NOT auto-enable missing
agents: the app enables the agents its workflows need (e.g. via
`agents({ use: ["reviewer", ...] })`). Workflows consume registered agent
instances via `capabilities.require(agentCapabilities).reviewer` — never a
`create*` factory.

The underlying factories `createPrReviewWorkflow(deps)` / `createBuildWorkflow(deps)`
are exported for manual composition.

## Markdown override mechanism

Instructions live in `.md` assets shipped with the package and resolve through a
**layered loader**: an app override dir wins, the package default (resolved via
`import.meta.url`, not cwd-walking) is the fallback. Adjust a built-in agent's
instructions without forking:

- `MAC_PROMPTS_DIR` — override dir for `prompts/<key>.md`.
- `MAC_AGENT_CONTEXT_DIR` — override dir for `agent-context/<key>.md`.

Resolution for key `reviewer`: `<overrideDir>/reviewer.md` → package
`prompts/reviewer.md`. To change an agent's *wiring* (tools, model, structure)
rather than just its words, use `defineAgent({ overrides })` from `@nearform/mac`.

## What this package does NOT own

- GitHub App auth / Octokit / webhooks → `@nearform/mac-github`.
- Slack Bolt / Socket Mode → `@nearform/mac-slack`.
- The host, router, capability registry implementation → `@nearform/mac`.
- `process.env` reads inside agent/workflow code — dependencies are injected.

See [`docs/examples.md`](../../docs/examples.md) for full preset examples.
