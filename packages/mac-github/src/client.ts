import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GitHubAppConfig } from "./auth.js";

/**
 * Build an Octokit authenticated as the GitHub App installation. Token
 * acquisition + refresh is handled by @octokit/auth-app. For permission-scoped,
 * agent-facing access prefer minting a downscoped token via ./auth.ts; this
 * client is for harness-side reads (and broad writes when a workflow needs it).
 */
export function createInstallationOctokit(config: GitHubAppConfig): Octokit {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
  });
}

/** Build a plain token-authed Octokit (e.g. from a minted installation token). */
export function createTokenOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}
