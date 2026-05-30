import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import { dbUrl } from "./config.js";
import { createChatAgent } from "./agents/chat.js";

/**
 * Last Light maintenance platform — Mastra entry point.
 *
 * M2: chat agent + memory + read-only GitHub tools. Workflows, connectors
 * (GitHub webhook / Slack / cron) and server.apiRoutes land in later
 * milestones. See ../../../MIGRATION.md.
 *
 * The SQLite file is resolved to an absolute path (see ./config.ts) so it works
 * regardless of process cwd — `mastra dev`/`build` run from .mastra/output where
 * a relative "./data/..." would hit libsql "error 14".
 */
export const mastra = new Mastra({
  storage: new LibSQLStore({ id: "lastlight", url: dbUrl() }),
  logger: new PinoLogger({ name: "lastlight", level: "info" }),
  agents: {
    chat: createChatAgent(),
  },
  workflows: {},
});
