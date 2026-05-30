import { Workspace, LocalFilesystem, LocalSandbox } from "@mastra/core/workspace";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Build a Mastra Workspace backed by a LocalFilesystem + LocalSandbox — the
 * in-process replacement for lastlight's agentic-pi/gondolin sandbox. The agent
 * that receives this workspace gets file tools + an `execute_command` tool, so
 * it can clone a repo, inspect code, and run commands.
 *
 * SPIKE SCOPE: LocalSandbox executes on the host with NO isolation and NO
 * egress firewall — both are deferred (see ../../../MIGRATION.md). Swap in a
 * remote/container sandbox (ComputeSDKSandbox → E2B/Daytona) before any
 * untrusted or production use.
 *
 * @param taskDir sub-directory name under the workspaces root (e.g. a task id),
 *   giving each run an isolated checkout dir.
 */
export function createCodeWorkspace(taskDir: string): Workspace {
  const root = process.env.LASTLIGHT_WORKSPACES_DIR
    ? resolve(process.env.LASTLIGHT_WORKSPACES_DIR)
    : resolve(process.cwd(), "workspaces");
  const base = resolve(root, taskDir);
  mkdirSync(base, { recursive: true });

  return new Workspace({
    filesystem: new LocalFilesystem({ basePath: base }),
    sandbox: new LocalSandbox({
      workingDirectory: base,
      // Pass the minted GitHub token through to git/gh inside the sandbox.
      env: githubTokenEnv(),
      timeout: 10 * 60_000,
    }),
  });
}

/** Env for the sandbox so `git`/`gh` authenticate as the App installation. */
function githubTokenEnv(token?: string): Record<string, string> {
  const t = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return t ? { GITHUB_TOKEN: t, GH_TOKEN: t } : {};
}
