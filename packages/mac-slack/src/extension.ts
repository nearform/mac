import type { MacExtension } from "@nearform/mac/core";
import type { SlackConfig } from "./config.js";
import { createSlackConnector } from "./connector.js";
import { postMessage, postStatus, updateStatus, setSlackClient, getSlackClient } from "./notify.js";
import { slackCapabilities, type SlackCapabilities } from "./capabilities.js";

/**
 * The Slack platform extension. It publishes the Slack capability bundle
 * (functions / metadata) into the registry and returns a `runtime` hook wired
 * to the Socket Mode connector. The connector is long-running, so it is exposed
 * via `runtime.start()/stop()` rather than as an `apiRoutes` descriptor.
 *
 * (Phase 6-ready; not yet exercised by the reference app, which still calls
 * `startSlackConnector` directly from server.ts.)
 */
export function slack(config: SlackConfig): MacExtension {
  const bundle: SlackCapabilities = {
    functions: {
      postMessage,
      postStatus,
      updateStatus,
      setSlackClient,
      getSlackClient,
    },
    metadata: {
      allowedUsers: config.allowedUsers,
      homeChannel: config.homeChannel,
    },
  };

  return {
    name: "slack",
    provides: [slackCapabilities],
    init(context) {
      context.capabilities.provide(slackCapabilities, bundle);
      const connector = createSlackConnector({ config, dispatch: context.dispatch });
      return {
        runtime: {
          start: () => connector.start(),
          stop: () => connector.stop(),
        },
      };
    },
  };
}
