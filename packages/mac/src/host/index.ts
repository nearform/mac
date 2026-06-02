/**
 * `@nearform/mac` host layer — `createMacApp` and its config/output types.
 *
 * Lives in the package ROOT (not `/core`) because it composes preset weight.
 */
export { createMacApp } from "./create-mac-app.js";
export type { MacAppConfig, MacPreset } from "./create-mac-app.js";
export { buildMcpSurface } from "./mcp.js";
export type { MacMcpConfig, MacMcpSurface } from "./mcp.js";

// Default data-driven classifier (preset layer) + its env-bound internals.
export {
  createLlmClassifier,
  assembleClassifierPrompt,
  extractGithubRefFromText,
  screenForInjection,
  flagPrefix,
  callLlm,
  defaultFastModel,
  resolveProvider,
  type LlmClassifierConfig,
  type ScreenResult,
} from "./classifier/index.js";
