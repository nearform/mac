# packages/mac-agent-workflows

Built-in agents (reviewer, architect, executor, fix, guardrails, chat), workflow
factories (pr-review, build), prompt/context loaders, and verdict/guardrail parsers.

## Key conventions

- **No env reads inside this package.** All dependencies (model, maxSteps,
  workspaceFactory, GitHub tools, prompt resolver) are injected via `CodingAgentDeps`
  or `ChatAgentDeps`. The package is env-agnostic by design.
- **Agents are factories.** `createReviewerAgent(deps)` etc. return agent instances;
  the host (or server app) registers them. Never instantiate directly.
- **Prompt layering:** each agent loads `base system → persona → agent-specific
  context → optional app override` via `PromptResolver` (`/src/loaders/prompts.ts`).
  Override files live in the consuming app, not here.
- **Workflow capabilities:** `githubCapabilities` is required; `slackCapabilities` is
  optional (workflows degrade gracefully when Slack is absent).

## Directory map

| Path | Contents |
|------|----------|
| `src/agents/` | Six coding agents + chat factory |
| `src/workflows/` | `pr-review.ts`, `build.ts` workflow factories |
| `src/loaders/` | Prompt resolver, agent-context loader, skills discovery |
| `src/parsers/` | `parseVerdict`, `parseGuardrails` structured-output parsers |
| `prompts/` | Markdown prompt files per agent |
| `agent-context/` | Soul, rules, security markdown assets |

## Tests

`test/` covers agent instruction contracts (contract guards, not golden snapshots),
workflow factory wiring, and maxSteps option threading. Run with `pnpm test`.
