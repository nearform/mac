// Load env from <repo-root>/secrets/.env BEFORE importing ./mastra — the Mastra
// instance reads config at module-evaluation time, and ESM evaluates imports in
// source order, so this side-effect import must be first. (See ./load-env.ts.)
import "./load-env.js";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { MastraServer, type HonoBindings, type HonoVariables } from "@mastra/hono";
import { mastra, macDispatch } from "./mastra/index.js";
import { slackConfig } from "./mastra/config.js";
import { startSlackConnector } from "@nearform/mac-slack";

/**
 * Self-owned Hono server that EMBEDS Mastra (via `@mastra/hono`), replacing the
 * `mastra dev`-owned server.
 *
 * Why we own the server:
 *  - Hot-reload is ours (`tsx watch`): a file change kills the whole process and
 *    re-binds cleanly — no more `mastra dev` EADDRINUSE-on-restart (it never
 *    `closeAllConnections()`'d, so a held Studio keep-alive blocked the re-bind).
 *  - Long-running connectors (Slack Socket Mode, cron) can start at boot here,
 *    after `serve()`, instead of needing a server-start hook Mastra doesn't expose.
 *  - No `mastra build` step / `.mastra/output` — deploy is a vanilla Node app.
 *
 * `server.init()` mounts the Mastra-managed routes (`/api/agents/*`,
 * `/api/workflows/*`, …) AND the `server.apiRoutes` configured on the instance
 * (our `/webhooks/github`, `/approve`, `/cli/*`) — verified against the adapter
 * source: `routes = this.customApiRoutes ?? this.mastra.getServer()?.apiRoutes`.
 *
 * Studio is launched separately and points at this server:
 *   `pnpm -C apps/server studio`  →  `mastra studio -s 4111`
 */
const app = new Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>();

// CORS — the `@mastra/hono` adapter applies NONE (verified: zero access-control
// handling in its dist), unlike the `mastra dev` server. Studio's browser SPA
// (:3000) calls this API at :4111 cross-origin, so we must supply it.
//
// CRITICAL: Studio sends its fetches with `credentials: 'include'`. Per the CORS
// spec a credentialed request CANNOT use a wildcard `Access-Control-Allow-Origin`
// — the browser blocks the *response* even though the preflight passes (hence the
// symptom: "preflight 204, actual fetch CORS error"). So we ECHO the caller's
// origin (not `*`) AND send `Access-Control-Allow-Credentials: true`. `origin` as
// a function makes Hono reflect the request origin (+ `Vary: Origin`); the
// `|| "*"` only covers no-Origin callers (curl/same-origin), where creds don't
// apply. Registered BEFORE init() so it also wraps the Mastra /api/* routes.
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-mastra-client-type", "x-mastra-dev-playground"],
    exposeHeaders: ["Content-Length", "X-Requested-With"],
  }),
);

const server = new MastraServer({ app, mastra });
await server.init();

const port = Number(process.env.PORT ?? 4111);

serve({ fetch: app.fetch, port });

// Long-running connectors start AFTER the server is up. This is the payoff of
// owning the server: a Socket Mode WebSocket just starts here, gated on config —
// no server-start hook needed, and `mastra build` (which we no longer run) can't
// accidentally open the socket since this is the runtime entrypoint, not a
// module side-effect.
const slack = slackConfig();
if (slack && macDispatch) {
  startSlackConnector(slack, macDispatch).catch((err: unknown) => {
    console.error("[server] Slack connector failed to start:", err);
  });
} else if (slack && !macDispatch) {
  // Slack tokens present but no router (no-GitHub dev fallback) — nothing to
  // dispatch to. The host/classifier need a GitHub platform to assemble.
  console.log("[server] Slack disabled (no router — set GitHub App secrets to enable the dispatch pipeline)");
} else {
  console.log("[server] Slack disabled (set SLACK_BOT_TOKEN + SLACK_APP_TOKEN to enable)");
}
