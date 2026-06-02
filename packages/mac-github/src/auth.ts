import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GITHUB_PERMISSION_PROFILES,
  type GitAccessProfile,
  type GitHubTokenPermissions,
} from "./profiles.js";

/**
 * GitHub App token broker — ported from the original `src/engine/git-auth.ts`,
 * trimmed to the token-minting core. We deliberately DROP the global
 * `~/.gitconfig` credential-helper writing (the original opt-in
 * `MAC_WRITE_GLOBAL_GIT` path): in the Mastra spike the coding agent runs
 * in a Mastra Workspace sandbox that receives the token via env, so the harness
 * never needs to touch the host git config. See ../../../MIGRATION.md.
 */

export interface GitHubAppConfig {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  /** Optional repo-name allowlist for the minted token. */
  repositories?: string[];
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Build a short-lived RS256 app JWT (no external dependency). */
function appJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Mint a GitHub App installation token, optionally downscoped to `permissions`
 * and/or a repository allowlist. Returns the token + expiry.
 */
export async function mintInstallationToken(
  config: GitHubAppConfig,
  permissions?: GitHubTokenPermissions,
): Promise<InstallationToken> {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  const jwt = appJwt(config.appId, privateKey);

  const body: Record<string, unknown> = {};
  if (config.repositories?.length) body.repositories = config.repositories;
  if (permissions && Object.keys(permissions).length > 0) body.permissions = permissions;
  const hasBody = Object.keys(body).length > 0;

  const res = await fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub App token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

/** Mint a token downscoped to a named permission profile. */
export function mintTokenForProfile(
  config: GitHubAppConfig,
  profile: GitAccessProfile,
): Promise<InstallationToken> {
  return mintInstallationToken(config, GITHUB_PERMISSION_PROFILES[profile]);
}

/** Read GitHub App config from the environment (conventional GITHUB_APP_* names). */
export function githubAppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  if (!appId || !privateKeyPath || !installationId) return null;
  return { appId, privateKeyPath, installationId };
}
