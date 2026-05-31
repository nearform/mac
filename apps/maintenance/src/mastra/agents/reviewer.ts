import { Agent } from "@mastra/core/agent";
import { agentMaxSteps, defaultModel } from "../config.js";
import { loadAgentContext } from "../agent-context.js";
import { workspaceFromContext, readToolsFromContext } from "./runtime.js";

function persona(): string {
  const p = loadAgentContext();
  return p ? `${p}\n\n---\n\n` : "";
}

/**
 * The PR-review agent. Read-only: it fetches the diff (and reads files / runs
 * commands in its sandbox if needed) and PRODUCES a verdict — it does NOT post.
 * The workflow step posts the review deterministically (see workflows/pr-review.ts),
 * mirroring lastlight's reviewer-emits-verdict / orchestrator-acts split, so a
 * run never silently "forgets" to post.
 *
 * REGISTERED agent (index.ts) so its tool calls trace to Studio; sandbox + read
 * tools are per-run, resolved from the requestContext (taskId + token).
 *
 * Output contract: stdout MUST begin with a line `VERDICT: APPROVE` |
 * `VERDICT: REQUEST_CHANGES` | `VERDICT: COMMENT`, then the markdown review body.
 */
export const reviewerAgent = new Agent({
  id: "reviewer",
  name: "reviewer",
  instructions:
    persona() +
    [
      "You are performing a pull-request review.",
      "1. Fetch the PR diff with github_get_pull_request_diff.",
      "2. Read surrounding files with github_read_file if you need context.",
      "3. Organise findings as: critical > important > suggestions > nits.",
      "",
      "OUTPUT CONTRACT — your response MUST begin with exactly one line:",
      "  VERDICT: APPROVE            (clean, no blocking issues)",
      "  VERDICT: REQUEST_CHANGES    (critical/important issues exist)",
      "  VERDICT: COMMENT            (feedback, but not blocking)",
      "Then a blank line, then the markdown review body. Cite file:line. Be concise.",
      "Do NOT post anything yourself — just produce the verdict + body.",
    ].join("\n"),
  model: defaultModel(),
  tools: readToolsFromContext,
  workspace: workspaceFromContext,
  defaultOptions: { maxSteps: agentMaxSteps() },
});

/**
 * The BUILD reviewer (build phase 5). Unlike the PR reviewer above, there is no
 * PR yet — the change lives only as a working-tree diff in the build checkout.
 * So this reviewer is given the diff (and the architect's plan) directly in the
 * prompt and judges it. Read-only, no tools, no workspace: deterministic input,
 * deterministic VERDICT out (parsed by `parseVerdict`, reused by the fix-loop).
 * Still REGISTERED (index.ts) so its LLM call traces to Studio.
 */
export const buildReviewerAgent = new Agent({
  id: "build-reviewer",
  name: "build-reviewer",
  instructions:
    persona() +
    [
      "You are an independent REVIEWER of a proposed code change. You are given",
      "the architect's plan and the working-tree diff. Judge whether the diff",
      "correctly and safely implements the plan.",
      "Organise findings as: critical > important > suggestions > nits.",
      "Approve only if there are no critical or important issues.",
      "",
      "OUTPUT CONTRACT — your response MUST begin with exactly one line:",
      "  VERDICT: APPROVE            (no blocking issues)",
      "  VERDICT: REQUEST_CHANGES    (critical/important issues exist)",
      "  VERDICT: COMMENT            (non-blocking feedback only)",
      "Then a blank line, then the markdown review body. Cite file:line. Be concise.",
    ].join("\n"),
  model: defaultModel(),
});

/** Parse the agent's `VERDICT: X` marker + body. Defaults to COMMENT. */
export function parseVerdict(text: string): {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
} {
  const trimmed = text.trimStart();
  const m = trimmed.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*\n?/i);
  if (!m) return { event: "COMMENT", body: text.trim() };
  const event = m[1]!.toUpperCase() as "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  return { event, body: trimmed.slice(m[0].length).trim() || "(no review body)" };
}
