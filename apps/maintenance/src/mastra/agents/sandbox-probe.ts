import { Agent } from "@mastra/core/agent";
import { defaultModel } from "../config.js";
import { createCodeWorkspace } from "../workspace.js";

/**
 * Throwaway probe agent (M3 piece A): proves a Workspace-backed agent gets the
 * `execute_command` tool and can run shell in the local sandbox. Remove once the
 * pr-review workflow is wired.
 */
export function createSandboxProbeAgent(): Agent {
  return new Agent({
    id: "sandbox-probe",
    name: "sandbox-probe",
    instructions:
      "You can run shell commands in a local sandbox via execute_command. " +
      "When asked, run the command and report its raw stdout.",
    model: defaultModel(),
    workspace: createCodeWorkspace("probe"),
  });
}
