// Loaders
export {
  resolvePrompt,
  defaultPromptResolver,
  type PromptResolver,
} from "./loaders/prompts.js";
export { loadAgentContext } from "./loaders/agent-context.js";
export {
  skillsContainerDir,
  skillsLocation,
  type SkillsLocation,
} from "./loaders/skills.js";

// Agent factories + the agents() selector
export {
  agents,
  type AgentsSelector,
  createChatAgent,
  createReviewerAgent,
  createBuildReviewerAgent,
  createArchitectAgent,
  createExecutorAgent,
  createFixAgent,
  createGuardrailsAgent,
  type CodingAgentDeps,
  type ChatAgentDeps,
} from "./agents/index.js";

// Per-run request-context plumbing for the registered coding agents
export {
  buildAgentContext,
  RC_TASK_ID,
  RC_TOKEN,
  RC_SKILLS,
  resolveWorkspace,
} from "./agents/runtime.js";

// Structured output parsers
export { parseVerdict } from "./parsers/verdict.js";
export { parseGuardrails } from "./parsers/guardrails.js";

// Capability bundle (also exported from ./capabilities)
export { agentCapabilities, type MacAgents } from "./capabilities.js";

// Workflow factories + the workflows() selector + built-in definitions
export {
  createPrReviewWorkflow,
  prReviewWorkflowDefinition,
  type PrReviewDeps,
  createBuildWorkflow,
  buildWorkflowDefinition,
  type BuildDeps,
  workflows,
  type WorkflowsSelector,
} from "./workflows/index.js";
