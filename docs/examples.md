# MAC examples

Four minimal, type-accurate snippets built on the real `createMacApp` API. They
assume you provide `model`, a `workspaceFactory`, and the relevant platform
config from your own env/secrets handling. See the package READMEs and
[`mastra-package-refactor.md`](./mastra-package-refactor.md) for the full API.

All four return a `MacPreset` you spread into `new Mastra(...)`:

```ts
interface MacPreset {
  agents; workflows; apiRoutes; mcpServers; mcp;
  dispatch;           // feed normalized EventEnvelopes here
  routes; classifierIntents;
  runtime?;           // start/stop for long-running connectors (Slack)
}
```

---

## 1. Minimal GitHub PR reviewer

The smallest useful app: a reviewer agent + the PR-review workflow over a GitHub
platform. The workflow definition is passed directly (it declares
`requiredAgents: ["reviewer"]`, so the host orders and preflights it).

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { github } from "@nearform/mac-github";
import { agents, prReviewWorkflowDefinition } from "@nearform/mac-agent-workflows";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  platforms: [
    github({
      appId: process.env.GITHUB_APP_ID!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
      managedRepos: ["nearform/example-repo"],
      botLogin: "last-light",
    }),
  ],
  agents: [agents({ use: ["reviewer"] })],
  workflows: [prReviewWorkflowDefinition],
});

export const mastra = new Mastra({
  agents: mac.agents,
  workflows: mac.workflows,
});
```

---

## 2. GitHub webhook app

Add `webhookSecret` to the `github()` config and the extension contributes an
inbound webhook `apiRoute`. Mount `mac.apiRoutes` on the Mastra server; the route
normalizes events and calls `mac.dispatch`, which the host's router resolves to a
workflow/agent.

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { github } from "@nearform/mac-github";
import { agents, prReviewWorkflowDefinition } from "@nearform/mac-agent-workflows";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  platforms: [
    github({
      appId: process.env.GITHUB_APP_ID!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
      managedRepos: ["nearform/example-repo"],
      botLogin: "last-light",
      webhookSecret: process.env.WEBHOOK_SECRET!, // ← enables the webhook route
    }),
  ],
  agents: [agents({ use: ["reviewer"] })],
  workflows: [prReviewWorkflowDefinition],
});

export const mastra = new Mastra({
  agents: mac.agents,
  workflows: mac.workflows,
  server: {
    apiRoutes: mac.apiRoutes, // includes POST /webhooks/github → mac.dispatch
  },
});

// `mac.dispatch(envelope)` is also callable directly if you ingest events
// from another source (cron, CLI, a custom route).
```

---

## 3. Slack chat connector

A Slack platform + a chat agent. The Slack connector is long-running, so start it
through `mac.runtime` **after** the HTTP server is listening — module import has
no side effects.

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { slack } from "@nearform/mac-slack";
import { agents } from "@nearform/mac-agent-workflows";
import { github } from "@nearform/mac-github";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  platforms: [
    // chat agents use GitHub read tools; include the platform that provides them
    github({
      appId: process.env.GITHUB_APP_ID!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
    }),
    slack({
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      allowedUsers: [],
      homeChannel: process.env.SLACK_HOME_CHANNEL,
    }),
  ],
  agents: [agents({ use: ["chat"] })],
});

export const mastra = new Mastra({
  agents: mac.agents,
  server: { apiRoutes: mac.apiRoutes },
});

// …construct and start the server first, then:
await mac.runtime?.start(); // Slack Socket Mode connects now
```

---

## 4. Full MAC preset

GitHub + Slack platforms, a selection of built-in agents, both workflow
definitions, host-level `routing` overrides, an opt-in MCP surface, and signed
approval links for the build workflow's human-in-the-loop gate.

```ts
import { Mastra } from "@mastra/core";
import { createMacApp } from "@nearform/mac";
import { github } from "@nearform/mac-github";
import { slack } from "@nearform/mac-slack";
import {
  agents,
  workflows,
} from "@nearform/mac-agent-workflows";

const mac = await createMacApp({
  model: "openai/gpt-4o",
  workspaceFactory,
  approvalLinks: {
    link: (runId, decision) =>
      `${process.env.PUBLIC_URL}/approve?run=${runId}&decision=${decision}`,
  },
  platforms: [
    github({
      appId: process.env.GITHUB_APP_ID!,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
      privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
      managedRepos: ["nearform/example-repo"],
      botLogin: "last-light",
      webhookSecret: process.env.WEBHOOK_SECRET!,
    }),
    slack({
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      allowedUsers: [],
      homeChannel: process.env.SLACK_HOME_CHANNEL,
    }),
  ],
  agents: [
    agents({ use: ["chat", "reviewer", "architect", "executor", "fix", "guardrails"] }),
  ],
  workflows: [workflows({ use: ["pr-review", "build"] })],
  routing: {
    includeDefaults: true,
    overrideTargets: {
      "github.pr_opened": { type: "workflow", id: "pr-review" },
    },
  },
  mcp: { enabled: true },
});

export const mastra = new Mastra({
  agents: mac.agents,
  workflows: mac.workflows,
  server: { apiRoutes: mac.apiRoutes },
  mcpServers: mac.mcpServers,
});

await mac.runtime?.start();
```
