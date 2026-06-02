import type { MacWorkflowDefinition } from "@nearform/mac/core";
import { prReviewWorkflowDefinition } from "./pr-review.js";
import { buildWorkflowDefinition } from "./build.js";

export {
  createPrReviewWorkflow,
  prReviewWorkflowDefinition,
  type PrReviewDeps,
} from "./pr-review.js";

export {
  createBuildWorkflow,
  buildWorkflowDefinition,
  type BuildDeps,
} from "./build.js";

/** Selector for the built-in workflows (mirrors `AgentsSelector`). */
export interface WorkflowsSelector {
  use: string[];
  /** Optional per-workflow model override, keyed by workflow id. Reserved. */
  models?: Record<string, string>;
}

/** The built-in workflow definitions the selector understands, keyed by id. */
const BUILTIN_WORKFLOWS: Record<string, MacWorkflowDefinition> = {
  "pr-review": prReviewWorkflowDefinition,
  build: buildWorkflowDefinition,
};

/**
 * The `workflows()` selector — returns the selected built-in workflow
 * definitions for the host to register. Each definition declares its own
 * capability `requires` / `requiredAgents`; the host orders inits by capability
 * and PREFLIGHTS that each `requiredAgents` id is registered (throwing early if
 * not). Note: the host does NOT auto-enable missing agents — the app must enable
 * the agents its workflows need (e.g. via `agents({ use: [...] })`). See the
 * refactor doc, "Transitive agent dependencies".
 */
export function workflows(selector: WorkflowsSelector): MacWorkflowDefinition[] {
  return selector.use.map((id) => {
    const def = BUILTIN_WORKFLOWS[id];
    if (!def) {
      throw new Error(
        `workflows({ use }) — unknown built-in workflow "${id}" (available: ${Object.keys(BUILTIN_WORKFLOWS).join(", ")})`,
      );
    }
    return def;
  });
}
