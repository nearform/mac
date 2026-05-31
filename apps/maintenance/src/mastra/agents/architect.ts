import { Agent } from "@mastra/core/agent";
import { agentMaxSteps, defaultModel } from "../config.js";
import { loadAgentContext } from "../agent-context.js";
import { workspaceFromContext, readToolsFromContext } from "./runtime.js";

/**
 * The ARCHITECT (build phase 2). Adapted from lastlight `prompts/architect.md`.
 *
 * Runs against the pre-cloned checkout (cwd = repo root in its sandbox). It is
 * analysis-only: read the code + issue, produce an implementation PLAN as its
 * response text. It does NOT edit code, commit, push, or open PRs — the
 * workflow owns git, the executor owns the edits. The plan text becomes the
 * `post_architect` approval gate's payload and the executor's brief.
 *
 * REGISTERED agent (index.ts) so its LLM + tool calls trace to Studio. Its
 * sandbox + GitHub read tools are per-run, resolved dynamically from the
 * requestContext (taskId + token) the build step passes (see agents/runtime.ts).
 */
function buildInstructions(): string {
  const persona = loadAgentContext();
  return (
    (persona ? `${persona}\n\n---\n\n` : "") +
    [
      "You are the ARCHITECT. Produce an implementation plan — you do NOT write code.",
      "Your sandbox cwd is the root of a fresh checkout of the target repo on the",
      "work branch. Use your file + execute_command tools to explore.",
      "",
      "1. Read CLAUDE.md / CONTRIBUTING.md / README for project conventions.",
      "2. Identify the exact test / lint / typecheck commands (you'll cite them so",
      "   the executor can verify its work).",
      "3. Locate the files involved, citing file:line.",
      "",
      "Then output a plan with these sections:",
      "- Problem Statement (2-5 sentences, with file:line references)",
      "- Summary of what needs to change",
      "- Files to modify (each with what changes and why)",
      "- Implementation approach (concrete, step-by-step)",
      "- Risks and edge cases",
      "- Test strategy (the commands to run)",
      "- Estimated complexity: simple / medium / complex",
      "",
      "HARD RULES: do NOT modify files, do NOT run git (no commit/branch/push),",
      "do NOT open a pull request. Output ONLY the plan as your response.",
    ].join("\n")
  );
}

export const architectAgent = new Agent({
  id: "architect",
  name: "architect",
  instructions: buildInstructions(),
  model: defaultModel(),
  tools: readToolsFromContext,
  workspace: workspaceFromContext,
  defaultOptions: { maxSteps: agentMaxSteps() },
});
