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
export const mastra = new Mastra({
  storage: new LibSQLStore({ id: "lastlight", url: "file:./data/mastra.db" }),
  logger: new PinoLogger({ name: "lastlight", level: "info" }),
  agents: {},
  workflows: {},
});
