# Harness & Workspaces — idiomatic Mastra for MAC's execution layer

> **Status:** Phase A (workspace/sandbox pluggability) and Phase B (interactive
> Harness, opt-in) are implemented. The deterministic `build`/`pr-review`
> workflows are unchanged. Cloud sandboxes and the interactive approval transport
> are wired as seams with `TODO(harness)` follow-ups, not yet production-complete.

MAC's execution layer predates two newer `@mastra/core` primitives:

- **`Workspace`** (`@mastra/core/workspace`) — a pluggable filesystem + sandbox abstraction.
- **`Harness`** (`@mastra/core/harness`) — a stateful, multi-turn orchestration layer
  (modes, threads, tool/plan approvals, subagents) that powers Mastra Code.

This doc records how MAC adopts both to become more idiomatic Mastra — so we can
run on **other sandboxes** (E2B/Daytona/container/remote) and drive the
**interactive/chat surface** through a proper Harness — **while keeping the
deterministic workflows intact**.

Verified against the installed `@mastra/core@1.37.1` types.

## 1. The two-lane execution model

MAC has two execution lanes that stay **separate**:

1. **Deterministic lane — workflows.** `createWorkflow` DAGs
   (`packages/mac-agent-workflows/src/workflows/build.ts:1`,
   `pr-review.ts:1`) triggered by webhook/CLI
   (`apps/server/src/mastra/server/cli-api.ts:26`), with human-in-the-loop via
   `suspend`/`resume` + HMAC approval links (build's gate at `build.ts:674`;
   `apps/server/src/mastra/server/approval.ts:74`). Agents only emit text; the
   workflow parses and acts. This determinism is the point — it is preserved.

2. **Interactive lane — Harness.** Multi-turn conversation, threads, mode
   switching, tool/plan approvals, subagents. Previously a bare
   `agent.generate(...)` dispatch (`packages/mac/src/host/create-mac-app.ts`),
   now optionally driven by a Mastra `Harness`.

## 2. Why modes ≠ workflows (the critical constraint)

A Harness **mode** is an agent, not a workflow:

```ts
// @mastra/core/dist/harness/types.d.ts
export interface HarnessMode<TState> {
  id: string;
  name?: string;
  default?: boolean;
  agent: Agent | ((state: TState) => Agent);   // ← Agent only
}
```

A `Workflow` is a `Step`, not an `Agent`, and is **not assignable** as a mode.
So deterministic workflows are **never converted into modes**. Instead they are
surfaced **into** the Harness as **tools** (`HarnessConfig.tools`,
`harness/types.d.ts`) — an interactive session can *trigger* a build/review, but
the workflow itself stays a DAG. This is the only sanctioned bridge between lanes.

## 3. Current-state inventory

- **Workspace is already idiomatic.** `apps/server/src/mastra/workspace.ts:56`
  builds a real `@mastra/core/workspace` `Workspace` from `LocalFilesystem` +
  `LocalSandbox` + `LocalSkillSource`, behind the `WorkspaceFactory` DI seam
  (`packages/mac/src/core/di.ts:16`). Workflows/agents consume it only through
  that seam (`packages/mac-agent-workflows/src/agents/runtime.ts`), so the
  backend can change without touching them.
- **Storage is already Harness-ready.** `MastraCompositeStore` (LibSQL + DuckDB)
  at `apps/server/src/mastra/index.ts` — `HarnessConfig.storage` wants exactly
  this type.
- **Mastra's sandbox model is provider classes.** `LocalSandbox` (in
  `@mastra/core/workspace`) has a built-in `isolation` option (`none`/`seatbelt`/
  `bwrap`, backed by an OS-level `native-sandbox`); cloud isolation is dedicated
  provider packages — `@mastra/e2b` (`E2BSandbox`), `@mastra/daytona`,
  `@mastra/modal`, `@mastra/blaxel`, AgentCore.
- **The interactive lane was a bare dispatch** — no modes, threads, approvals,
  subagents, or steer/abort.

## 4. Gap summary

| Concern | Before | Idiomatic target | Effort | State |
|---|---|---|---|---|
| Deterministic workflows | `createWorkflow` DAGs, webhook/CLI | unchanged; exposed as Harness tools | none | kept |
| Sandbox | host execution, no isolation | single `MAC_SANDBOX` (`auto`/`local`/`seatbelt`/`bwrap` + cloud `e2b`/`daytona`/…) behind `WorkspaceFactory` | S | **done** |
| Workspace abstraction | already `@mastra/core/workspace` | unchanged | done | — |
| Storage | `MastraCompositeStore` | unchanged (Harness-ready) | done | — |
| Interactive/chat | bare `agent.generate` dispatch | `Harness` (modes, threads, approvals, subagents) | L | **done (opt-in)** |
| HITL approval | workflow `suspend`/`resume` + HMAC | keep for workflows; Harness `respondToToolApproval`/`respondToPlanApproval` for interactive | M | seam + TODO |
| Built-in tools (ask_user / submit_plan / task / subagent) | none | Harness built-ins | M | available via modes |

## 5. Phase A — Workspace/sandbox pluggability

`apps/server/src/mastra/workspace.ts` selects the execution mode from a single
`MAC_SANDBOX` env var (default `auto`). Local modes are built in; cloud providers
live in a `SANDBOX_PROVIDERS` registry (opt-in). An unknown value throws a message
listing the local modes + registered cloud providers + the wiring recipe. The
`WorkspaceFactory`/`resolveWorkspace` signatures are unchanged, so workflows and
agents are untouched.

- `auto` (default) — local host, native isolation where available
  (`LocalSandbox.detectIsolation()`), else none.
- `local` — local host, no isolation. `seatbelt` — macOS `sandbox-exec`.
  `bwrap` — Linux bubblewrap.
- `e2b`/`daytona`/`modal`/`blaxel`/`agentcore` — cloud; install the `@mastra/*`
  package + register a factory returning `{ sandbox }` (cloud providers bring their
  own FS).

Under a local isolation mode, writes are confined to the per-run workspace **root**
(+ network toggle). The repo is checked out into a `checkout/` sub-folder of that
root, and tool caches (`HOME`/npm/XDG) are redirected to the root **alongside** the
checkout (`isolatedCacheEnv`) — never **inside** it. So no host cache dirs are
written, and the caches stay out of the git tree (the workflow's `git add -A`, run
with cwd = `checkout/`, can't commit them). **Verified** by `scripts/try-sandbox.ts`:
under `seatbelt`/`auto` a workspace write and a redirected cache write succeed while a
`$HOME` write is blocked (`Operation not permitted`).

**Audit:** git/artifact operations route through `workspace.sandbox.executeCommand`
/ `workspace.filesystem` (`packages/mac-agent-workflows/src/workflows/git.ts`),
not raw `node:fs`/`process.cwd()` — so they are portable to a remote sandbox. The
only host-side `mkdirSync`/`cwd` is the local workspaces root in `workspace.ts`.

## 6. Phase B — Harness for the interactive surface

A `Harness` is the home for the interactive lane, kept fully separate from the
workflows. Implementation (opt-in via `MAC_INTERACTIVE_HARNESS=1`):

- **`apps/server/src/mastra/harness.ts`** — `createMacHarness(deps)` builds a
  Harness that reuses the app's `MastraCompositeStore`, chat `Memory`, and the
  **same** `WorkspaceFactory` as the workflows (so interactive sessions get the
  pluggable sandbox too). One default `chat` mode (the existing chat agent — an
  agent, not a workflow), with an extension point for a future `plan` mode.
- **Workflows as tools** — `run_build` / `run_pr_review` `createTool`s whose
  `execute` calls the **outer** `mastra.getWorkflow(...).createRun().start(...)`
  (fire-and-forget, mirroring `cli-api.ts`). The Harness builds its own inner
  Mastra, so the tools reach the outer instance via a lazy `getWorkflow` getter.
- **`createInteractiveDispatch(harness)`** — adapts the Harness to the
  platform-neutral `InteractiveDispatch` contract
  (`packages/mac/src/core/di.ts`), so `@nearform/mac` never imports the harness.
  The host (`create-mac-app.ts`) delegates `agent`-target routes to it when
  configured; otherwise the original `agent.generate` path runs unchanged. One
  external conversation id → one Harness thread; the assistant reply is
  accumulated from `message_end` events (`sendMessage` returns `void`).
- **Approvals split cleanly** — the workflow `suspend`/`resume` + HMAC flow
  (`approval.ts`) is untouched. Interactive tool/plan approvals use the Harness's
  `respondToToolApproval` / `respondToPlanApproval`.

### Open follow-ups (`TODO(harness)`)
- **Approval transport** — interactive tool approvals currently auto-approve;
  wire a real transport (e.g. Slack interactive buttons) for tool + plan approval.
- **Thread mapping / locking** — the external-id → thread map is in-memory and
  single-process; revisit for multi-instance deploys.
- **Per-thread workspace** — the interactive workspace uses one `"interactive"`
  dir; key it per harness thread so concurrent sessions don't share a checkout.
- **`plan` mode** — extension point wired but unused (agents only).
- **Cloud sandbox provider** — wiring a real cloud provider (`@mastra/e2b` etc.)
  needs a newer `@mastra/core` (provider classes absent in 1.37.1) + credentials;
  if the provider constructs async, the `WorkspaceFactory.create` seam may need an
  async variant.
- **Full builds under isolation** — `seatbelt`/`bwrap` grant r/w to the per-run
  workspace root (covering both `checkout/` and the redirected caches) + `/tmp`;
  builds that reach for other host paths need extra `readWritePaths`.

## 7. Risks

- **Harness is alpha-era** (`@mastra/core` 1.5.0+); API churn is a real risk for
  a central interactive surface — hence the `MAC_INTERACTIVE_HARNESS` gate while
  it's runtime-verified.
- **Cloud-sandbox env/secret contract** differs from host-local; the curated
  allowlist is local-only and a remote provider must forward secrets deliberately.
- **Approval drift** — the workflow HITL gate and the Harness interactive
  approvals are independent mechanisms; keep them from diverging in UX/semantics.
