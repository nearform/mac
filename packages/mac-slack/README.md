# @nearform/mac-slack

Slack platform package for **MAC** (Mastra Agentic Coding). Owns the Socket Mode
connector, outbound message/status posting helpers, markdown → Slack mrkdwn
formatting, Slack message normalization to `EventEnvelope`, and the `slack()`
extension for `createMacApp`.

> Extracted from the reference app's `connectors/slack/*` in the MAC refactor.

## Entry points

| Import | Contents | Weight |
| --- | --- | --- |
| `@nearform/mac-slack` | `slack()` extension, Socket Mode connector, notify helpers, mrkdwn formatter — the full runtime API. | pulls Slack Bolt + Web API |
| `@nearform/mac-slack/capabilities` | `SlackCapabilities` + the `slackCapabilities` key — the type-only contract. | dependency-light (no Bolt at import) |

Agent/workflow packages should import `SlackCapabilities` / `slackCapabilities`
from `/capabilities` so they never pull Slack Bolt transitively.

## The `slack()` extension

```ts
import { slack } from "@nearform/mac-slack";

const platform = slack({
  botToken: process.env.SLACK_BOT_TOKEN!,   // xoxb-…
  appToken: process.env.SLACK_APP_TOKEN!,   // xapp-… (Socket Mode)
  allowedUsers: [],                          // empty = allow everyone
  homeChannel: process.env.SLACK_HOME_CHANNEL,
});
// Pass `platform` to createMacApp({ platforms: [platform] }).
```

During `init` it publishes a configured `SlackCapabilities` bundle into the
registry under `slackCapabilities`:

- `functions.postMessage(...)` / `functions.postStatus(...)` / `functions.updateStatus(...)`
- `functions.setSlackClient(...)` / `functions.getSlackClient()`
- `metadata.allowedUsers`, `metadata.homeChannel`

and returns a `runtime` hook wired to the Socket Mode connector.

## Runtime start/stop ownership

The connector is **long-running**, so it is exposed via `runtime.start()` /
`runtime.stop()` rather than an `apiRoutes` descriptor. Module import has **no**
side effects — nothing connects to Slack until the host calls `start()`. The
consuming app starts it explicitly, after its HTTP server is listening:

```ts
const mac = await createMacApp({ /* …, platforms: [slack(cfg)] */ });
// …construct and start the Mastra/Hono server first…
await mac.runtime?.start();   // now Socket Mode connects
```

Lower-level building blocks are also exported for manual composition:

```ts
import {
  createSlackConnector, startSlackConnector,   // Socket Mode lifecycle
  postMessage, postStatus, updateStatus,        // outbound helpers
  markdownToSlackMrkdwn,                         // pure formatter
  type SlackConfig, type SlackTarget,
} from "@nearform/mac-slack";
```

## What this package does NOT own

- Agent instructions or workflow logic — it only normalizes events and delivers messages.
- Routing decisions ("this Slack message means run build") — events go to `dispatch`; the `@nearform/mac` router decides.
- Reading `process.env` — config enters at the app boundary as a resolved `SlackConfig`.

See [`docs/examples.md`](../../docs/examples.md) for a Slack chat connector
example.
