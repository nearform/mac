import { Mastra } from "@mastra/core";
import { MastraCompositeStore } from "@mastra/core/storage";
import { LibSQLStore } from "@mastra/libsql";
import { DuckDBStore } from "@mastra/duckdb";
import { PinoLogger } from "@mastra/loggers";
import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";
import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
import { createMacApp, defineAgent } from "@nearform/mac";
import { github, githubAppConfigFromEnv } from "@nearform/mac-github";
import { slack } from "@nearform/mac-slack";
import {
  agents,
  prReviewWorkflowDefinition,
  buildWorkflowDefinition,
} from "@nearform/mac-agent-workflows";
import type { DispatchFn } from "@nearform/mac/core";
import type { ApiRoute } from "@mastra/core/server";
import {
  dbUrl,
  duckDbPath,
  defaultModel,
  agentMaxSteps,
  slackConfig,
  approvalLink,
  webhookSecret,
  botLogin,
  getManagedRepos,
  isManagedRepo,
} from "./config.js";
import { createChatAgent } from "./agents/chat.js";
import { createCodeWorkspace } from "./workspace.js";
import { approvalRoute } from "./server/approval.js";
import { healthApiRoute, buildApiRoute, runApiRoute } from "./server/cli-api.js";

/**
 * MAC maintenance platform — Mastra entry point.
 *
 * M2: chat agent + memory + read-only GitHub tools.
 * M5: connectors land as Mastra apiRoutes on the built-in server —
 *   - POST /webhooks/github  GitHub webhook → router → dispatch (build/pr-review)
 *   - GET  /approve          ✅/❌ approval-link → resume a suspended build run
 *   - POST /cli/build, /cli/run + GET /health  the CLI thin-client trigger + probe
 * Slack (Socket Mode) + cron are the next slice. See ../../../MIGRATION.md.
 *
 * The SQLite file is resolved to an absolute path (see ./config.ts) so it works
 * regardless of process cwd — `mastra dev`/`build` run from .mastra/output where
 * a relative "./data/..." would hit libsql "error 14".
 *
 * Phase 11 — `mac.dispatch` is now the only router. `createMacApp` assembles the
 * data-driven classifier from the merged intent catalogue and owns the
 * pre-rules → deterministic → classifier pipeline. The app passes its routing
 * config (the `@mac-nf` mention pattern + managed-repo seam) and a
 * `webhookSecret` so `github()` mounts the inbound webhook route wired to
 * `mac.dispatch`; `server.ts` drives the Slack connector with the same dispatch.
 * The legacy `engine/{dispatch,router,classifier,screen,llm}.ts` are deleted.
 */

// GitHub App config from env — null when secrets are absent (e.g. a bare
// `mastra dev` before secrets are wired). When null, the `github()` platform is
// simply not installed: `agents()` declares GitHub `optional`, so the coding
// agents still construct (read tools disabled), and the GitHub-dependent
// workflows are not enabled. So `createMacApp` composes the app either way.
const ghCfg = githubAppConfigFromEnv();

/**
 * The preset slice spread into the `Mastra` instance below. Built by a SINGLE
 * code path: `createMacApp` always composes the app. GitHub and Slack platforms
 * are conditionally installed (only when their secrets are present), and the
 * coding agents degrade gracefully when GitHub is absent because the `agents()`
 * selector declares `optional: [githubCapabilities]` (read tools disabled, like
 * chat). This removes the former hand-rolled "no-GitHub" branch that duplicated
 * agent construction — and the `maxSteps` divergence it caused.
 */
interface MacPresetSlice {
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  /** Inbound API routes contributed by the host (e.g. the GitHub webhook). */
  apiRoutes: ApiRoute[];
  /** The single router (always assembled by createMacApp). */
  dispatch: DispatchFn;
}

async function buildPreset(): Promise<MacPresetSlice> {
  const sc = slackConfig();
  const mac = await createMacApp({
    model: defaultModel(),
    workspaceFactory: {
      create: (taskId: string, options?: { token?: string; skills?: string[] }) =>
        createCodeWorkspace(taskId, options),
    },
    // Signed ✅/❌ approval links for the build workflow's post_architect gate
    // (reads publicBaseUrl + HMAC from env — must stay app-side).
    approvalLinks: { link: (runId, decision) => approvalLink(runId, decision) },
    platforms: [
      // GitHub is installed only when secrets are present; without it the
      // coding agents still construct (read tools disabled) via the optional
      // capability, and the GitHub-dependent workflows are simply not enabled.
      ...(ghCfg
        ? [
            github({
              appId: ghCfg.appId,
              installationId: ghCfg.installationId,
              privateKeyPath: ghCfg.privateKeyPath,
              managedRepos: getManagedRepos(),
              // Mount the inbound webhook route wired to mac.dispatch (Phase 11).
              webhookSecret: webhookSecret(),
              botLogin: botLogin(),
            }),
          ]
        : []),
      // Passing slack() makes slackCapabilities available so pr-review can post
      // to the shared client. We IGNORE `mac.runtime` — the startSlackConnector
      // in server.ts still owns the Socket Mode lifecycle (and sets the shared
      // client postMessage uses); starting mac.runtime too would double-start it.
      ...(sc ? [slack(sc)] : []),
    ],
    agents: [
      // The coding agents come from the package selector; `maxSteps` threads the
      // app's configured budget through so it applies on this (host) path.
      agents({
        use: ["reviewer", "build-reviewer", "architect", "executor", "fix", "guardrails"],
        maxSteps: agentMaxSteps(),
      }),
      // Chat is registered app-side rather than via `use: ["chat"]` because the
      // app owns chat's memory + pre-built read tools (see ./agents/chat.ts);
      // the package `createChatAgent` takes those as injected deps.
      defineAgent({
        id: "chat",
        description: "Conversational GitHub assistant.",
        create: () => createChatAgent(),
      }),
    ],
    // GitHub-dependent workflows require `githubCapabilities`, so enable them
    // only when GitHub is configured — otherwise the host fails preflight.
    workflows: ghCfg ? [prReviewWorkflowDefinition, buildWorkflowDefinition] : [],
    // Routing: the @mac-nf mention gate + managed-repo seam. The host
    // builds the default LLM classifier from the merged intent catalogue
    // (CHAT/BUILD/REVIEW) since no `classifier.classify` is injected.
    routing: {
      guards: { mentionPattern: /@mac-nf\b/i },
      isManagedRepo,
      managedRepos: getManagedRepos,
    },
  });
  return {
    agents: mac.agents,
    workflows: mac.workflows,
    apiRoutes: mac.apiRoutes,
    dispatch: mac.dispatch,
  };
}

// Top-level await (ESM TLA; tsx + mastra build support it).
const preset = await buildPreset();

/**
 * The single router for inbound events (GitHub webhook + Slack). Consumed by
 * `server.ts` to drive the Slack connector. Always assembled by createMacApp —
 * even without GitHub, so a Slack-only dev boot still routes to the chat agent.
 */
export const macDispatch = preset.dispatch;

export const mastra = new Mastra({
  // Composite store (per Mastra's observability docs): operational domains
  // (threads, messages, workflow snapshots, …) stay on LibSQL; the OBSERVABILITY
  // domain (AI traces + metrics — analytical/OLAP data) is routed to DuckDB.
  storage: new MastraCompositeStore({
    id: "mac-storage",
    default: new LibSQLStore({ id: "mac", url: dbUrl() }),
    domains: {
      observability: new DuckDBStore({ id: "mac-obs", path: duckDbPath() }).observability,
    },
  }),
  logger: new PinoLogger({ name: "mac", level: "info" }),
  // AI tracing → persisted to the DuckDB observability store, surfaced in
  // Studio's Observability tab + metrics. Without this, agent runs (incl. every
  // sandbox `execute_command` the build agents make, with inputs/outputs) leave
  // no trace beyond the live console — which is why a BLOCKED guardrails run was
  // a black box. SensitiveDataFilter strips secrets/keys from span payloads.
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mac",
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
  // Build-workflow agents (+ chat) come from `createMacApp` (`mac.agents`) so the
  // host owns the registry the pr-review/build workflows consume. They are still
  // REGISTERED in this Mastra instance so the observability exporter wires in
  // (via __registerMastra) and their LLM + tool calls (incl. every sandbox
  // execute_command) trace to Studio. Their per-run sandbox + GitHub token are
  // resolved dynamically from requestContext at each generate() call (see
  // agents/runtime.ts; build/pr-review steps pass it).
  agents: preset.agents,
  workflows: preset.workflows,
  server: {
    apiRoutes: [
      // The GitHub webhook route is contributed by the host (github() extension,
      // wired to mac.dispatch). The health + approval + CLI routes stay app-owned.
      ...preset.apiRoutes,
      healthApiRoute,
      approvalRoute,
      buildApiRoute,
      runApiRoute,
    ],
  },
  // The `@nearform/*` workspace packages are source-only (their `exports` point
  // at `./src/*.ts` with `.js`-extension internal imports). Without this, `mastra
  // dev`/`build` externalizes them and Node fails to resolve the `.ts` sources.
  // transpilePackages tells the bundler to compile them instead.
  bundler: {
    transpilePackages: ["@nearform/mac-github", "@nearform/mac-slack", "@nearform/mac", "@nearform/mac-agent-workflows"],
  },
});
