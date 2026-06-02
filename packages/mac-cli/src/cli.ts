#!/usr/bin/env node

/**
 * MAC CLI — thin client that triggers the running Mastra server.
 *
 * Ported from the original `src/cli.ts`, adapted for the Mastra port:
 *  - Default server is the Mastra server (http://localhost:4111), not 8644.
 *  - Health check hits Mastra's built-in `GET /health`.
 *  - Triggers hit our apiRoutes `POST /cli/build` and `POST /cli/run`.
 *  - The admin-login / setup-wizard paths are dropped (no admin auth in the spike).
 *
 * Usage:
 *   pnpm cli <github-url>            Triage that issue (default — cheap, M6)
 *   pnpm cli <owner/repo#number>     Same, shorthand
 *   pnpm cli build <github-url>      Run the FULL build cycle (architect→PR)
 *   pnpm cli build <owner/repo#N>    Same, shorthand
 *   pnpm cli review <owner/repo#N>   Review that PR (pr-review workflow)
 *
 * The CLI does NOT run agents — it POSTs to the server. Start it first:
 *   pnpm -C apps/server dev   (or: pnpm dev)
 */

const SERVER_URL = process.env.MAC_URL || "http://localhost:4111";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
MAC CLI

Usage:
  pnpm cli <github-url>          Triage that one issue (default — cheap, M6)
  pnpm cli <owner/repo#number>   Same, shorthand
  pnpm cli build <github-url>    Run the FULL build cycle (architect/executor/reviewer/PR)
  pnpm cli build <owner/repo#N>  Same, shorthand
  pnpm cli review <owner/repo#N> Review that PR

The server must be running (pnpm dev). Set MAC_URL to override.
`);
  process.exit(0);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function main() {
  // Check server is running (Mastra's built-in /health).
  try {
    const healthRes = await fetch(`${SERVER_URL}/health`);
    if (!healthRes.ok) throw new Error();
  } catch {
    console.error(`Server not running at ${SERVER_URL}`);
    console.error(`Start it first: pnpm dev`);
    process.exit(1);
  }

  const firstArg = args[0] ?? "";

  // ── Explicit `build` subcommand: the full build cycle → /cli/build ────────
  if (firstArg === "build") {
    const target = args[1];
    const parsed = target ? parseGitHubRef(target) : null;
    if (!parsed) {
      console.error(`Usage: pnpm cli build <github-url> | <owner/repo#N>`);
      process.exit(1);
    }
    const { owner, repo, number } = parsed;
    console.log(`Triggering BUILD cycle for ${owner}/${repo}#${number}...`);
    await post("/cli/build", { owner, repo, issueNumber: number });
    return;
  }

  // ── `review` subcommand: pr-review workflow → /cli/run ────────────────────
  if (firstArg === "review") {
    const target = args[1];
    const parsed = target ? parseGitHubRef(target) : null;
    if (!parsed) {
      console.error(`Usage: pnpm cli review <owner/repo#N> | <pr-url>`);
      process.exit(1);
    }
    const { owner, repo, number } = parsed;
    console.log(`Triggering PR review for ${owner}/${repo}#${number}...`);
    await post("/cli/run", { skill: "pr-review", context: { repo: `${owner}/${repo}`, prNumber: number } });
    return;
  }

  // ── triage/health/security: not yet wired (M6) — kept for parity ──────────
  if (["triage", "health", "security"].includes(firstArg)) {
    const skillMap: Record<string, string> = {
      triage: "issue-triage",
      health: "repo-health",
      security: "security-review",
    };
    const skill = skillMap[firstArg] ?? firstArg;
    const target = args[1] ?? "";
    const parsed = parseGitHubRef(target);
    const context = parsed
      ? { repo: `${parsed.owner}/${parsed.repo}`, issueNumber: parsed.number, sender: "cli" }
      : { repos: [target], mode: "scan" };
    console.log(`Triggering ${firstArg} (${skill})...`);
    await post("/cli/run", { skill, context });
    return;
  }

  // ── Default: bare <github-url> / <owner/repo#N> → triage (M6) or review ────
  const parsed = parseGitHubRef(firstArg);
  if (!parsed) {
    console.error(`Could not parse GitHub reference: ${firstArg}`);
    console.error(`Expected: https://github.com/owner/repo/issues/N or owner/repo#N`);
    console.error(`For a full build cycle: pnpm cli build ${firstArg}`);
    process.exit(1);
  }
  const { owner, repo, number, type } = parsed;
  const isPr = type === "pr";
  console.log(`Triggering ${isPr ? "PR review" : "issue triage"} for ${owner}/${repo}#${number}...`);
  if (!isPr) console.log(`(For a full build cycle: pnpm cli build ${owner}/${repo}#${number})`);
  await post("/cli/run", {
    skill: isPr ? "pr-review" : "issue-triage",
    context: {
      repo: `${owner}/${repo}`,
      ...(isPr ? { prNumber: number } : { issueNumber: number }),
      sender: "cli",
    },
  });
}

async function post(path: string, payload: unknown): Promise<void> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`Accepted: ${JSON.stringify(data)}`);
    console.log(`Check server logs for progress.`);
  } else {
    console.error(`Failed (${res.status}): ${JSON.stringify(data)}`);
    process.exit(1);
  }
}

// ── GitHub reference parser ─────────────────────────────────────────

function parseGitHubRef(input: string | undefined) {
  if (!input) return null;
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!,
      number: parseInt(urlMatch[4]!, 10),
      type: urlMatch[3] === "pull" ? "pr" : "issue",
    };
  }
  const shortMatch = input.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
      type: "issue",
    };
  }
  return null;
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
