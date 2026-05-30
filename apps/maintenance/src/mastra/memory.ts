import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { dbUrl } from "./config.js";

/**
 * Shared conversation memory backed by LibSQL. One thread per conversation
 * (e.g. a Slack thread or GitHub issue thread), keyed by `threadId` at call
 * time. Replaces lastlight's SessionManager + messaging_sessions tables.
 */
export function createChatMemory(): Memory {
  return new Memory({
    storage: new LibSQLStore({ id: "lastlight-memory", url: dbUrl() }),
    options: {
      lastMessages: 20,
    },
  });
}
