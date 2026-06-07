import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { resolve } from "path";
import type { Command } from "commander";
import { printBanner, printReady } from "../lib/banner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = resolve(__dirname, "../../../.."); // packages/mac-cli/src/commands → repo root
const SERVER_DIR = resolve(ROOT_DIR, "apps/server");

export function registerDev(program: Command): void {
  program
    .command("dev")
    .description("Start the MAC server + Mastra Studio (hot-reload)")
    .option("-p, --port <port>", "API server port", "4111")
    .action(async (opts: { port: string }) => {
      await runDev("dev", parseInt(opts.port, 10));
    });

  program
    .command("serve")
    .description("Start the MAC server in production mode (no watch, no studio)")
    .option("-p, --port <port>", "API server port", "4111")
    .action(async (opts: { port: string }) => {
      await runDev("serve", parseInt(opts.port, 10));
    });
}

async function runDev(mode: "dev" | "serve", port: number): Promise<void> {
  printBanner({ clearScreen: true });

  const serverArgs = mode === "dev" ? ["exec", "tsx", "watch", "src/server.ts"] : ["exec", "tsx", "src/server.ts"];
  const serverProcess = spawn("pnpm", serverArgs, {
    cwd: SERVER_DIR,
    stdio: "pipe",
    env: { ...process.env, PORT: String(port) },
  });

  const studioProcess =
    mode === "dev"
      ? spawn("pnpm", ["exec", "mastra", "studio", "-s", String(port)], {
          cwd: SERVER_DIR,
          stdio: "pipe",
        })
      : null;

  const children: ChildProcess[] = [serverProcess, ...(studioProcess ? [studioProcess] : [])];

  pipeOutput(serverProcess, "[server]");
  if (studioProcess) {
    // Suppress all studio stdout — the URL is already in the ready box.
    // Only forward stderr so actual errors are visible.
    studioProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
  }

  serverProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`\nServer exited with code ${code}\n`);
      studioProcess?.kill("SIGTERM");
      process.exit(code);
    }
  });

  const cleanup = (): void => {
    for (const child of children) child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const serverUrl = `http://localhost:${port}`;
  await pollUntilReady(serverUrl);

  printReady({
    apiPort: port,
    studioPort: mode === "dev" ? 3000 : undefined,
  });
}

function pipeOutput(
  child: ChildProcess,
  prefix: string,
  suppress?: (line: string) => boolean | void,
): void {
  const cyan = "\x1b[36m";
  const magenta = "\x1b[35m";
  const reset = "\x1b[0m";
  const color = prefix === "[server]" ? cyan : magenta;

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const isErr = stream === child.stderr;
    stream.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        if (suppress?.(line)) continue;
        const out = isErr ? process.stderr : process.stdout;
        out.write(`${color}${prefix}${reset} ${line}\n`);
      }
    });
  }
}

async function pollUntilReady(serverUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/health`);
      if (res.ok) return;
    } catch {
      // not yet up
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  process.stderr.write(`Server did not respond within ${timeoutMs / 1000}s\n`);
  process.exit(1);
}
