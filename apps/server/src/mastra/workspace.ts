import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  LocalSkillSource,
} from "@mastra/core/workspace";
import { skillsLocation } from "@nearform/mac-agent-workflows";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Build a Mastra Workspace backed by a LocalFilesystem + LocalSandbox — the
 * in-process replacement for the original's agentic-pi/gondolin sandbox. The agent
 * that receives this workspace gets file tools + an `execute_command` tool, so
 * it can clone a repo, inspect code, install dependencies, and run commands.
 *
 * SPIKE SCOPE: LocalSandbox executes on the host with NO isolation and NO
 * egress firewall — both are deferred (see ../../../MIGRATION.md). Swap in a
 * remote/container sandbox (ComputeSDKSandbox → E2B/Daytona) before any
 * untrusted or production use.
 *
 * @param taskDir sub-directory name under the workspaces root (e.g. a task id),
 *   giving each run an isolated checkout dir.
 * @param options.skills skill folder names to scope this workspace to. The
 *   workflow STEP decides the list (per-step skill policy); we resolve it to the
 *   package's skills container via `skillsLocation` and wire a `LocalSkillSource`
 *   so the agent gets `skill`/`skill_read`/`skill_search` for just those skills.
 *   Skills live OUTSIDE the per-task checkout (a `LocalSkillSource`, not the
 *   workspace filesystem), so they don't depend on what the run cloned.
 */
export function createCodeWorkspace(
  taskDir: string,
  options?: { token?: string; skills?: string[] },
): Workspace {
  const root = process.env.MAC_WORKSPACES_DIR
    ? resolve(process.env.MAC_WORKSPACES_DIR)
    : resolve(process.cwd(), "workspaces");
  const base = resolve(root, taskDir);
  mkdirSync(base, { recursive: true });

  // Per-step skill scoping: when the step requested skills, point the workspace
  // at the package's skills container (a read-only LocalSkillSource) and expose
  // only the requested skill folders. No skills requested → none loaded.
  const skills = options?.skills ?? [];
  const skillWiring =
    skills.length > 0
      ? (() => {
          const loc = skillsLocation(skills);
          return {
            skillSource: new LocalSkillSource({ basePath: loc.basePath }),
            skills: loc.paths,
          };
        })()
      : {};

  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: base }),
    sandbox: new LocalSandbox({
      workingDirectory: base,
      env: sandboxEnv(),
      // Generous default: dependency installs (`npm install`) and bringing up
      // service deps (`docker compose up`) are slow. Per-command override is
      // still possible via executeCommand options. Configurable for CI.
      timeout: Number(process.env.MAC_SANDBOX_TIMEOUT_MS ?? 15 * 60_000),
    }),
    ...skillWiring,
  });
}

/**
 * Environment exposed inside the sandbox. LocalSandbox does NOT inherit the host
 * environment by default (only PATH) — so toolchains the build agents rely on
 * (`npm`/`pnpm`/`node`, `docker`/`docker compose`) would fail to find their
 * home dirs, caches, or daemon socket. We pass a CURATED toolchain allowlist
 * (no provider/API secrets) so `npm install` and `docker compose` work for
 * spinning up dependencies, while keeping `OPENAI_API_KEY` etc. out of reach of
 * arbitrary package postinstall scripts.
 *
 * - `MAC_SANDBOX_INHERIT_ENV=1` → pass the FULL host env (debug/escape
 *   hatch; less secure). Provider keys become visible to executed commands.
 * - A minted GitHub token is NOT injected here: the build workflow clones with
 *   an inline short-lived token and strips it, so the checkout has no push path
 *   (the assistant never pushes). pr-review/chat still pass GITHUB_TOKEN if the
 *   host has one set.
 *
 * @param token optional GitHub token to expose as GITHUB_TOKEN/GH_TOKEN.
 */
function sandboxEnv(token?: string): Record<string, string> {
  const host = process.env;

  if (host.MAC_SANDBOX_INHERIT_ENV === "1") {
    return { ...stripUndefined(host), ...githubTokenEnv(token) };
  }

  // Toolchain essentials: shells/paths, locale, temp, plus the var prefixes npm,
  // node version managers, and docker read. Secrets are intentionally excluded.
  const KEYS = [
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "TZ",
    "NVM_DIR",
    "VOLTA_HOME",
    "COREPACK_HOME",
    // docker / docker compose: CLI location, daemon socket, active context.
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "COLIMA_HOME",
  ];
  const env: Record<string, string> = {};
  for (const k of KEYS) {
    const v = host[k];
    if (v !== undefined) env[k] = v;
  }
  // Pass through any npm_config_* / NPM_* overrides (registry, cache, proxy…).
  for (const [k, v] of Object.entries(host)) {
    if (v !== undefined && (k.startsWith("npm_config_") || k.startsWith("NPM_"))) {
      env[k] = v;
    }
  }
  return { ...env, ...githubTokenEnv(token) };
}

/** Expose a GitHub token to git/gh in the sandbox, only when one is provided. */
function githubTokenEnv(token?: string): Record<string, string> {
  const t = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return t ? { GITHUB_TOKEN: t, GH_TOKEN: t } : {};
}

function stripUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
