import { Mastra } from "@mastra/core";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { PinoLogger } from "@mastra/loggers";
import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";
import { dbUrl, duckDbPath } from "./config.js";
import { createChatAgent } from "./agents/chat.js";
import { createSandboxProbeAgent } from "./agents/sandbox-probe.js";
import { guardrailsAgent } from "./agents/guardrails.js";
import { architectAgent } from "./agents/architect.js";
import { executorAgent, fixAgent } from "./agents/executor.js";
import { reviewerAgent, buildReviewerAgent } from "./agents/reviewer.js";
import { prReviewWorkflow } from "./workflows/pr-review.js";
import { buildWorkflow } from "./workflows/build.js";
import { githubWebhookRoute } from "./server/github-webhook.js";
import { approvalRoute } from "./server/approval.js";
import { buildApiRoute, runApiRoute } from "./server/cli-api.js";

/**
 * Last Light maintenance platform — Mastra entry point.
 *
 * M2: chat agent + memory + read-only GitHub tools.
 * M5: connectors land as Mastra apiRoutes on the built-in server —
 *   - POST /webhooks/github  GitHub webhook → router → dispatch (build/pr-review)
 *   - GET  /approve          ✅/❌ approval-link → resume a suspended build run
 *   - POST /api/build, /api/run + GET /health  the CLI thin-client trigger
 * Slack (Socket Mode) + cron are the next slice. See ../../../MIGRATION.md.
 *
 * The SQLite file is resolved to an absolute path (see ./config.ts) so it works
 * regardless of process cwd — `mastra dev`/`build` run from .mastra/output where
 * a relative "./data/..." would hit libsql "error 14".
 */
export const mastra = new Mastra({
  // Composite store (per Mastra's observability docs): operational domains
  // (threads, messages, workflow snapshots, …) stay on LibSQL; the OBSERVABILITY
  // domain (AI traces + metrics — analytical/OLAP data) is routed to DuckDB.
  storage: new MastraCompositeStore({
    id: "lastlight-storage",
    default: new LibSQLStore({ id: "lastlight", url: dbUrl() }),
    domains: {
      observability: new DuckDBStore({ id: "lastlight-obs", path: duckDbPath() }).observability,
    },
  }),
  logger: new PinoLogger({ name: "lastlight", level: "info" }),
  // AI tracing → persisted to the DuckDB observability store, surfaced in
  // Studio's Observability tab + metrics. Without this, agent runs (incl. every
  // sandbox `execute_command` the build agents make, with inputs/outputs) leave
  // no trace beyond the live console — which is why a BLOCKED guardrails run was
  // a black box. SensitiveDataFilter strips secrets/keys from span payloads.
  observability: new Observability({
    configs: {
      default: {
        serviceName: "lastlight",
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  agents: {
    chat: createChatAgent(),
    sandboxProbe: createSandboxProbeAgent(),
    // Build-workflow agents — REGISTERED (not ad-hoc) so Mastra wires the
    // observability exporter (via __registerMastra) and their LLM + tool calls
    // (incl. every sandbox execute_command) trace to Studio. Their per-run
    // sandbox + GitHub token are resolved dynamically from requestContext at each
    // generate() call (see agents/runtime.ts; build/pr-review steps pass it).
    guardrails: guardrailsAgent,
    architect: architectAgent,
    executor: executorAgent,
    fix: fixAgent,
    reviewer: reviewerAgent,
    "build-reviewer": buildReviewerAgent,
  },
  workflows: {
    "pr-review": prReviewWorkflow,
    build: buildWorkflow,
  },
  server: {
    apiRoutes: [
      githubWebhookRoute,
      approvalRoute,
      buildApiRoute,
      runApiRoute,
    ],
  },
  // `@lastlight/github` is a source-only workspace package (exports ./src/index.ts
  // with `.js`-extension internal imports). Without this, `mastra dev`
  // externalizes it and Node fails to resolve `./profiles.js` (a .ts file).
  // transpilePackages tells the bundler to compile it instead.
  bundler: {
    transpilePackages: ["@lastlight/github"],
  },
});
