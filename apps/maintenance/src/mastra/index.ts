import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";

/**
 * Last Light maintenance platform — Mastra entry point.
 *
 * Milestone 1 skeleton: storage + logger only. Agents, workflows, tools,
 * connectors (GitHub webhook / Slack / cron) and server.apiRoutes are layered
 * in over the following milestones. See ../../../MIGRATION.md.
 */

// Resolve the SQLite file to an absolute path so it works regardless of the
// process cwd. `mastra dev` and `mastra build` run from .mastra/output, where a
// relative "./data/..." would point at a non-existent dir (libsql error 14).
// Override with LASTLIGHT_DB_URL (e.g. a libsql:// URL) in production.
const dbUrl =
  process.env.LASTLIGHT_DB_URL ??
  `file:${process.env.LASTLIGHT_STATE_DIR ?? process.cwd()}/lastlight.db`;

export const mastra = new Mastra({
  storage: new LibSQLStore({ id: "lastlight", url: dbUrl }),
  logger: new PinoLogger({ name: "lastlight", level: "info" }),
  agents: {},
  workflows: {},
});
