/**
 * `@nearform/mac` root — the batteries-included entry point.
 *
 * Re-exports the `/core` contracts and authoring helpers for app ergonomics
 * (app code may import `defineWorkflow` etc. from here; subpackages must import
 * them from `@nearform/mac/core`). The `createMacApp(...)` preset/host lives in
 * `./host` (Phase 6).
 */
export * from "./core/index.js";
export * from "./host/index.js";
