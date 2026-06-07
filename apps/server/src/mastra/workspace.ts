import {
  Workspace,
  LocalFilesystem,
  LocalSandbox,
  LocalSkillSource,
} from "@mastra/core/workspace";
import type {
  IsolationBackend,
  WorkspaceSandbox,
  WorkspaceFilesystem,
} from "@mastra/core/workspace";
import { skillsLocation } from "@nearform/mac-agent-workflows";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { workspacesDir } from "./config.js";

/**
 * Build a Mastra Workspace for a task/run. The execution mode is chosen by a
 * single `MAC_SANDBOX` env var (default `auto`); the agent that receives this
 * workspace gets file tools + an `execute_command` tool, so it can clone a repo,
 * inspect code, install dependencies, and run commands.
 *
 * `MAC_SANDBOX` values:
 *   - local host (built in): `local` (no isolation), `seatbelt` (macOS), `bwrap`
 *     (Linux), `auto` (best native backend for this platform, else none).
 *   - cloud (opt-in): `e2b`, `daytona`, `modal`, `blaxel`, `agentcore` — install
 *     the provider's `@mastra/*` package and register a factory in
 *     {@link SANDBOX_PROVIDERS}. See README "Sandbox".
 *
 * Under local isolation the per-run workspace ROOT is the only writable host
 * area. The repo is checked out into a `checkout/` SUB-folder of that root, and
 * tool caches/HOME are redirected to the root ALONGSIDE the checkout (see
 * `sandboxEnv`) — never inside it. This keeps `Library/Caches`, `.npm`, `.config`
 * etc. OUT of the git working tree, so the workflow's `git add -A` can't sweep
 * them into a commit. Cloud providers bring their own filesystem; the local modes
 * pair `LocalSandbox` with a `LocalFilesystem`.
 *
 * @param taskDir sub-directory name under the workspaces root (e.g. a task id),
 *   giving each run an isolated workspace root (and `checkout/` within it).
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
  // Per-run workspace ROOT under the workspaces root (defaults to <repo-root>/
  // data/workspaces, cwd-independent; override with MAC_WORKSPACES_DIR). The repo
  // is checked out into `checkout/` WITHIN this root; tool caches/HOME live at the
  // root, alongside (not inside) the checkout — so they never enter the git tree.
  // See config.ts and `isolatedCacheEnv`.
  const root = resolve(workspacesDir(), taskDir);
  const checkout = resolve(root, "checkout");

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

  const mode = (process.env.MAC_SANDBOX ?? "auto").toLowerCase();

  // Local host execution (built in), optionally OS-isolated per the mode.
  const localMode = Object.hasOwn(LOCAL_MODES, mode) ? LOCAL_MODES[mode] : undefined;
  if (localMode) {
    // `recursive` creates the root too; both FS + sandbox target the checkout dir.
    mkdirSync(checkout, { recursive: true });
    return new Workspace({
      filesystem: new LocalFilesystem({ basePath: checkout }),
      sandbox: makeLocalSandbox({ root, checkout, isolation: localMode() }),
      ...skillWiring,
    });
  }

  // Remote/cloud providers — opt-in, registered after installing their package.
  const provider = Object.hasOwn(SANDBOX_PROVIDERS, mode) ? SANDBOX_PROVIDERS[mode] : undefined;
  if (!provider) {
    throw new Error(
      `Unknown MAC_SANDBOX="${mode}". Local modes: local, seatbelt, bwrap, auto. ` +
        `Cloud providers (install @mastra/<x> + register in workspace.ts): ` +
        `${Object.keys(SANDBOX_PROVIDERS).join(", ") || "none wired yet"}. ` +
        `See README "Sandbox".`,
    );
  }
  const { sandbox, filesystem } = provider({ base: checkout, token: options?.token });
  return new Workspace({
    ...(filesystem ? { filesystem } : {}),
    sandbox,
    ...skillWiring,
  });
}

/**
 * Local `MAC_SANDBOX` modes → `LocalSandbox` isolation backend. `auto` detects the
 * platform's native backend (seatbelt on macOS / bwrap on Linux, else none).
 */
const LOCAL_MODES: Record<string, () => IsolationBackend> = {
  local: () => "none",
  seatbelt: () => "seatbelt",
  bwrap: () => "bwrap",
  auto: () => LocalSandbox.detectIsolation().backend,
};

/** What a sandbox-provider factory returns. Cloud providers omit `filesystem`. */
interface SandboxParts {
  sandbox: WorkspaceSandbox;
  filesystem?: WorkspaceFilesystem;
}
type SandboxProviderFactory = (args: { base: string; token?: string }) => SandboxParts;

/**
 * Remote/cloud sandbox providers for `MAC_SANDBOX` (e2b, daytona, …). Empty by
 * default — each is opt-in: install its package and register a one-line factory
 * returning `{ sandbox }` (cloud sandboxes bring their own filesystem). Example
 * (after `pnpm --filter @nearform/mac-server add @mastra/e2b`):
 *
 *     import { E2BSandbox } from "@mastra/e2b";            // needs E2B_API_KEY
 *     e2b: () => ({ sandbox: new E2BSandbox({ timeout: 15 * 60_000 }) }),
 *
 * Daytona → `@mastra/daytona` (DaytonaSandbox), Modal → `@mastra/modal`
 * (ModalSandbox), Blaxel → `@mastra/blaxel`, AgentCore → AgentCoreRuntimeSandbox.
 * Then run with `MAC_SANDBOX=e2b`. See README "Sandbox".
 */
const SANDBOX_PROVIDERS: Record<string, SandboxProviderFactory> = {};

/**
 * Standard device files that tools open read+write — `git`/`node` open `/dev/null`
 * with O_RDWR. Mastra's native profile allows reads + ioctl on these but NOT
 * writes, so we add them to `readWritePaths` (seatbelt → `file-write*`; bwrap →
 * bind-mount). Filtered to those that exist so a bwrap bind of a missing node
 * doesn't error (e.g. `/dev/dtracehelper` is macOS-only).
 */
const DEVICE_NODES = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"].filter(
  (p) => existsSync(p),
);

/**
 * Build a host `LocalSandbox` with the given OS-level isolation backend.
 *
 * Commands run with cwd = `checkout` (the repo sub-folder), while tool caches
 * (npm/XDG/HOME) are redirected to the workspace `root` ABOVE it (see `sandboxEnv`)
 * — so caches sit alongside the checkout, never inside it, and the workflow's
 * `git add -A` can't commit them.
 *
 * Under isolation, Mastra's profile allows reads globally but permits WRITES only
 * to the granted paths (+ /tmp). We grant the workspace `root` (which contains both
 * the checkout and the cache dirs) plus the standard device nodes tools need —
 * keeping the per-run root the only writable host area.
 */
function makeLocalSandbox(opts: {
  root: string;
  checkout: string;
  isolation: IsolationBackend;
}): LocalSandbox {
  const { root, checkout, isolation } = opts;
  return new LocalSandbox({
    workingDirectory: checkout,
    // Curated host-env (toolchains, no secrets); under isolation, caches are
    // redirected to `root` (alongside the checkout) so nothing writes to host
    // cache dirs OR into the git tree (see sandboxEnv).
    env: sandboxEnv({ isolation, cacheRoot: root }),
    // Generous default: dependency installs (`npm install`) and bringing up service
    // deps (`docker compose up`) are slow. Per-command override via executeCommand.
    timeout: Number(process.env.MAC_SANDBOX_TIMEOUT_MS ?? 15 * 60_000),
    isolation,
    // Grant write to the workspace root (covers the checkout sub-dir AND the cache
    // dirs) + standard device nodes + network. No host cache paths — caches live
    // under `root` via env, keeping isolation tight.
    nativeSandbox:
      isolation === "none"
        ? undefined
        : {
            allowNetwork: process.env.MAC_SANDBOX_ALLOW_NETWORK !== "0",
            readWritePaths: [root, ...DEVICE_NODES],
          },
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
 * - When `isolation` is on, tool caches/home are redirected to `cacheRoot` (the
 *   workspace root, ABOVE the checkout — see `isolatedCacheEnv`) so isolated runs
 *   never write to host cache dirs NOR into the git tree.
 *
 * @param opts.token optional GitHub token to expose as GITHUB_TOKEN/GH_TOKEN.
 * @param opts.isolation active isolation backend (caches redirect when not `none`).
 * @param opts.cacheRoot the workspace root (cache redirect target, sibling of the
 *   checkout — NOT the checkout itself, so caches stay out of the committed tree).
 */
function sandboxEnv(opts?: {
  token?: string;
  isolation?: IsolationBackend;
  cacheRoot?: string;
}): Record<string, string> {
  const host = process.env;
  const baseEnv =
    host.MAC_SANDBOX_INHERIT_ENV === "1" ? stripUndefined(host) : curatedEnv(host);

  // Under OS-level isolation, writes are confined to the workspace root, so point
  // every tool cache/home to `cacheRoot` (the root, alongside the checkout) instead
  // of host cache dirs — keeping them writable but out of the git tree.
  const cacheEnv =
    opts?.isolation && opts.isolation !== "none" && opts.cacheRoot
      ? isolatedCacheEnv(opts.cacheRoot)
      : {};

  return { ...baseEnv, ...cacheEnv, ...githubTokenEnv(opts?.token) };
}

/** Curated toolchain allowlist (no provider/API secrets). */
function curatedEnv(host: NodeJS.ProcessEnv): Record<string, string> {
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
  return env;
}

/**
 * Redirect tool caches/config/home to the workspace `root` so isolated runs never
 * write to host cache dirs (~/.npm, ~/.cache, …). Under seatbelt/bwrap the
 * workspace root is the only writable host location, so HOME + XDG + npm cache all
 * point at it. Crucially the root is the PARENT of the `checkout/` sub-folder, so
 * these dirs (`Library/Caches`, `.npm`, `.config`, …) land ALONGSIDE the git tree,
 * not inside it — the workflow's `git add -A` (cwd = checkout) never sees them.
 * Reads stay global (the profile allows `file-read*`), so the toolchain (node/npm
 * via PATH/NVM_DIR) still resolves from its host install.
 */
function isolatedCacheEnv(root: string): Record<string, string> {
  return {
    HOME: root,
    XDG_CACHE_HOME: resolve(root, ".cache"),
    XDG_DATA_HOME: resolve(root, ".local/share"),
    XDG_CONFIG_HOME: resolve(root, ".config"),
    XDG_STATE_HOME: resolve(root, ".local/state"),
    npm_config_cache: resolve(root, ".cache/npm"),
  };
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
