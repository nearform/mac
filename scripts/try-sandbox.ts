/**
 * Manual sandbox-isolation probe. Exercises the REAL `createCodeWorkspace`
 * factory (apps/server) under each MAC_SANDBOX mode and checks that isolation is
 * actually enforced: a write inside the workspace succeeds, while a write to $HOME
 * (outside the workspace) is allowed under `local` but BLOCKED under
 * `seatbelt`/`bwrap`/`auto`.
 *
 * Run:  node_modules/.bin/tsx scripts/try-sandbox.ts [mode...]   (default: local seatbelt)
 */
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createCodeWorkspace } from "../apps/server/src/mastra/workspace.js";

const OUTSIDE = join(homedir(), "mac-isolation-probe.txt");

async function trial(mode: string): Promise<void> {
  process.env.MAC_SANDBOX = mode;
  const root = mkdtempSync(join(tmpdir(), `mac-sbx-${mode}-`));
  process.env.MAC_WORKSPACES_DIR = root;
  if (existsSync(OUTSIDE)) unlinkSync(OUTSIDE);

  const ws = createCodeWorkspace("probe");
  await ws.init();
  const exec = (cmd: string, args: string[]) => ws.sandbox!.executeCommand!(cmd, args);

  const inside = await exec("sh", ["-c", "echo hi > ok.txt && cat ok.txt"]);
  const outside = await exec("sh", ["-c", `echo nope > "${OUTSIDE}" 2>&1 || true`]);
  const leaked = existsSync(OUTSIDE);

  // /dev/null must be writable (git/node open it O_RDWR) even under isolation.
  const devnull = await exec("sh", ["-c", ": > /dev/null && echo devnull-ok"]);

  // Caches: confirm $HOME and npm cache resolve INSIDE the workspace and are
  // writable there (so npm/pnpm never touch host ~/.npm under isolation).
  const cache = await exec("sh", [
    "-c",
    'mkdir -p "$npm_config_cache" && echo ok > "$npm_config_cache/probe" && ' +
      'printf "HOME=%s npm_cache=%s\\n" "$HOME" "$npm_config_cache"',
  ]);

  console.log(`\n=== MAC_SANDBOX: ${mode} ===`);
  console.log(`  inside  write : exit=${inside.exitCode} stdout=${JSON.stringify(inside.stdout.trim())}`);
  console.log(`  outside write : exit=${outside.exitCode} stderr=${JSON.stringify((outside.stderr ?? "").trim().slice(0, 160))}`);
  console.log(`  $HOME file created (leak)? ${leaked ? "YES  ⚠️  no isolation" : "no   ✅  blocked"}`);
  console.log(`  /dev/null write: exit=${devnull.exitCode} ${devnull.stdout.trim() || (devnull.stderr ?? "").trim().slice(0, 120)}`);
  console.log(`  cache write   : exit=${cache.exitCode} ${cache.stdout.trim()}`);
  const cacheInside = cache.stdout.includes(root);
  console.log(`  cache inside workspace? ${cacheInside ? "yes  ✅" : "no   (not redirected — expected for 'none')"}`);

  if (existsSync(OUTSIDE)) unlinkSync(OUTSIDE);
  await ws.destroy();
  rmSync(root, { recursive: true, force: true });
}

const modes = process.argv.slice(2);
for (const m of modes.length ? modes : ["local", "seatbelt"]) {
  await trial(m);
}
console.log("\ndone.");
