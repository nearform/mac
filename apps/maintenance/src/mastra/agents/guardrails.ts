import { Agent } from "@mastra/core/agent";
import { agentMaxSteps, defaultModel } from "../config.js";
import { loadAgentContext } from "../agent-context.js";
import { workspaceFromContext } from "./runtime.js";

/**
 * The GUARDRAILS check (build phase 1). Adapted from lastlight
 * `prompts/guardrails.md`, trimmed to the pre-flight detection: confirm the
 * checkout has a working test runner (and note lint/typecheck), so later phases
 * can actually verify their work. Analysis-only; the workflow parses the
 * READY / BLOCKED marker (see workflows/build.ts) and decides whether to gate.
 *
 * REGISTERED agent (see index.ts) so its tool calls trace to Studio. Its sandbox
 * is the per-run checkout, resolved dynamically from the requestContext taskId
 * the build step passes (see agents/runtime.ts). It has the sandbox so it can
 * actually invoke the project's test command rather than guessing from config.
 */
function buildInstructions(): string {
  const persona = loadAgentContext();
  return (
    (persona ? `${persona}\n\n---\n\n` : "") +
    [
      "You are running a PRE-FLIGHT GUARDRAILS CHECK before any implementation.",
      "Your sandbox cwd is the repo checkout root.",
      "",
      "GOAL: confirm the project has a TEST RUNNER you can invoke using the PROJECT'S",
      "OWN configured commands, so later phases can verify their work. Find the real",
      "commands — DO NOT invent or guess test-runner flags.",
      "",
      "Dependencies have ALREADY been installed for you by the workflow (the Node",
      "package manager's `install` was run, so `node_modules` is present). You should",
      "NOT need to install anything — just RUN the project's configured test script.",
      "Only run an install yourself if a run errors with a clearly-missing-dependency",
      "message (and then run the project's real install: `npm install` / `pnpm install`,",
      "or `docker compose up -d` for service deps).",
      "",
      "Find the commands in this order:",
      "1. Detect the package manager from the lockfile: package-lock.json → npm,",
      "   pnpm-lock.yaml → pnpm, yarn.lock → yarn, bun.lockb → bun.",
      "2. Read the project's CONFIGURED scripts and use them VERBATIM:",
      "   - Node: `package.json` \"scripts\". If a \"test\" script exists, the test",
      "     command is `npm test` (or `pnpm test` / `yarn test` / `bun test`) — run",
      "     the script AS DEFINED. Do NOT reconstruct the underlying runner call.",
      "   - Likewise use the \"lint\" / \"typecheck\" / \"build\" (tsc) scripts if present.",
      "   - Also check CONTRIBUTING.md / CLAUDE.md / README for documented commands.",
      "   - Non-Node: pyproject.toml/tox.ini/Makefile (`pytest`, `make test`),",
      "     Rust `cargo test`, Go `go test ./...`.",
      "3. RUN the project's test script exactly as defined to confirm the runner starts.",
      "",
      "RULES (these matter — a prior run wrongly BLOCKED a working vitest project):",
      "- Invoke the project's OWN scripts. NEVER append or invent runner flags",
      "  (e.g. don't add Jest's `--runTestsByPath` or a bogus `--reporter` to a",
      "  vitest project). If a `test` script exists, `npm test` IS the command.",
      "- A runner that STARTS and executes tests is USABLE even if some tests FAIL or",
      "  error — the executor needs a working runner, not a green suite. Only conclude",
      "  it's broken if the runner cannot start AT ALL (no script/framework, or every",
      "  plain invocation errors before any test runs).",
      "- If an invocation errors on flags/options, RETRY the plain project script",
      "  before deciding it's broken.",
      "",
      "OUTPUT CONTRACT — your response MUST begin with exactly one line:",
      "  GUARDRAILS: READY     (the project's test command exists and the runner executes)",
      "  GUARDRAILS: BLOCKED   (no test framework/script at all, or the runner cannot start)",
      "Then a blank line, then a short report listing the EXACT commands you found",
      "(test / lint / typecheck) and any caveats. The executor will rely on these commands.",
    ].join("\n")
  );
}

export const guardrailsAgent = new Agent({
  id: "guardrails",
  name: "guardrails",
  instructions: buildInstructions(),
  model: defaultModel(),
  workspace: workspaceFromContext,
  // Enough tool-loop budget to install deps + run test/lint/typecheck and
  // still emit the final GUARDRAILS: marker (Mastra's default of 5 is too low).
  defaultOptions: { maxSteps: agentMaxSteps() },
});

/** Parse the guardrails `GUARDRAILS: READY|BLOCKED` marker + report body. */
export function parseGuardrails(text: string): {
  ready: boolean;
  report: string;
} {
  const trimmed = text.trimStart();
  const m = trimmed.match(/^GUARDRAILS:\s*(READY|BLOCKED)\s*\n?/i);
  if (!m) return { ready: false, report: text.trim() };
  return { ready: m[1]!.toUpperCase() === "READY", report: trimmed.slice(m[0].length).trim() };
}
