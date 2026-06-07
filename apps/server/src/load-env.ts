// Side-effect module: load environment variables from `<repo-root>/secrets/.env`
// (alongside the GitHub App pem — both gitignored). Import this FIRST, before any
// module that reads `process.env` at evaluation time (the Mastra instance reads
// config — DB paths, model, GitHub App — at module-eval). ESM evaluates imports
// in source order, so `import "./load-env.js"` must precede `./mastra/...`.
//
// Both entry points import it: `server.ts` (the Hono server) and `mastra/index.ts`
// (loaded directly by `mastra studio`, which never runs server.ts). Resolving the
// root by walking up for pnpm-workspace.yaml keeps this cwd- and bundle-independent.
// Falls back to dotenv's default (cwd `.env`) when secrets/.env is absent.
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const secretsEnv = join(findRepoRoot(), "secrets", ".env");
loadEnv(existsSync(secretsEnv) ? { path: secretsEnv } : undefined);
