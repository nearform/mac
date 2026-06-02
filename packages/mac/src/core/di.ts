import type { Workspace } from "@mastra/core/workspace";

/**
 * Platform-neutral dependency-injection contracts (MAC refactor Phase 2).
 *
 * These are the app-provided seams reusable workflows depend on instead of
 * reading process-wide config. Platform-specific brokers (e.g. the GitHub token
 * broker) live in their platform package's `/capabilities`, not here.
 */

/**
 * Creates an isolated working area for each task/run. The app decides what backs
 * it (local filesystem+sandbox for dev, a remote/container sandbox for prod, a
 * read-only no-op for workflows that don't execute code).
 */
export interface WorkspaceFactory {
  create(taskId: string, options?: { token?: string }): Workspace;
}

/** Builds signed approval/reject links for human-in-the-loop gates. */
export interface ApprovalLinkBuilder {
  link(runId: string, decision: "approve" | "reject"): string;
}
