# Plan: Migrate legacy dispatch/classifier onto the host contribution router

> Status: **done (Phase 11).** Follow-on to the MAC package refactor
> (`docs/mastra-package-refactor.md`, all 12 phases complete).
>
> `mac.dispatch` is now the only router. The legacy
> `engine/{dispatch,router,classifier,screen,llm}.ts`, `managed-repos.ts`, the
> core `router.ts`/`routes.ts`, and the app `router.test.ts` are deleted. The
> default data-driven classifier lives in `@nearform/mac` (`host/classifier/`);
> the host pipeline (pre-rules → deterministic → classifier) is in
> `create-mac-app.ts`; pr-review/build/chat contribute their routes + intents
> from their definitions; the app threads `routing.guards`/`isManagedRepo` and a
> `webhookSecret` into `createMacApp`. Covered by
> `packages/mac/test/dispatch-router.test.ts`. `pnpm -r typecheck` + `pnpm test`
> green.
>
> **Freedom note:** nothing in production consumes this path — the app boots but
> isn't deployed. So this was a **clean cutover**, not a behavior-preserving
> migration: the legacy router/dispatcher was replaced outright and deleted. The
> tests cover *correctness of the new system*, not parity with the old one; where
> the legacy behavior was awkward it was simplified (see the notes below).

## Goal

Make `createMacApp`'s contribution router (`mac.dispatch`) the single routing
system, driven by a **data-driven classifier** assembled from the merged intent
catalogue, and **retire** the legacy classifier/skill dispatcher. After this,
`routing.classifier.extraIntents` and intent-keyed `routing.overrideTargets`
(e.g. `slack.deploy`) become live — today they are inert.

## Current state (the two systems)

### Legacy path — what actually runs today
GitHub webhook (`createGithubWebhookRoute({ createDispatch: c => createDispatcher(c.get("mastra")) })`)
and Slack (`startSlackConnector(slack, createDispatcher(mastra))`) both route via:

```
EventEnvelope
  → engine/dispatch.ts  createDispatcher(mastra)
      → engine/router.ts  routeEvent(envelope, { db?, classify, screen, flagPrefix, isManagedRepo, managedRepos })
          (app wrapper injects the concrete deps into core routeEvent)
      → core routeEvent  →  RoutingResult = { action:"skill", skill, context } | { action:"reply", message } | { action:"ignore", reason }
      → engine/dispatch.ts  dispatchSkill(skill, context, envelope)
          → startWorkflow(mastra, "pr-review"|"build", inputData)   // by id, fire-and-forget
          | chat agent generate | nudge reply | "🚧 not wired (M6)"
```

Pieces involved (all in `apps/maintenance/src/mastra/`):
- `engine/dispatch.ts` — `createDispatcher`, `dispatchSkill`, `startWorkflow`, `slackOrigin`, `splitRepo`, `num`, `str`. `IMPLEMENTED = {"pr-review","github-orchestrator"}`.
- `engine/router.ts` — thin wrapper injecting the app's classifier/screen/managed-repo into the core `routeEvent`.
- `engine/classifier.ts` — `classifyComment` over a **hardcoded** `CLASSIFIER_PROMPT` + closed `CommentIntent` enum; `extractGithubRefFromText`.
- `engine/screen.ts` — `screenForInjection`, `flagPrefix`, `wrapUntrusted`, untrusted markers.
- `engine/llm.ts` — `callLlm`, `defaultFastModel`, `resolveProvider` (Anthropic/OpenAI/OpenRouter; reads provider keys from env).
- `@nearform/mac/core` `routeEvent` (`packages/mac/src/core/router.ts`) — the deterministic `switch` over `EventType` + the per-intent skill mapping for comments/messages.

### Host path — built (Phase 6) but unused
`createMacApp` returns `mac.dispatch`: matches `EventEnvelope` against the assembled
`MacRouteContribution[]` (by `source` / `eventTypes` / `when`, priority-sorted) and runs
the matched `MacRouteTarget` (`workflow` → `createRun().start({inputData: input(ctx)})`,
`agent` → `generate`, `reply`, `ignore`). It has **no classifier step** — it only
matches deterministic contributions. Routes/intents are assembled from extension
contributions + `routing.add`/`overrideTargets`/`extraIntents`, and every
workflow/agent target is preflighted against the registries.

The workflows are already built by the host (Phase 7/8 DI factories); only the
route→run step is still legacy.

## Legacy behavior to port (the spec)

This is what `core routeEvent` + `dispatchSkill` do today — the target system must
cover the cases we keep:

**Deterministic GitHub events**
- `issue.opened` / `issue.reopened` → `issue-triage` *(no workflow exists; legacy replies "not wired")*.
- `pr.opened` / `pr.synchronize` / `pr.reopened` → **`pr-review`** workflow. Input: `{ owner, repo, number: prNumber, ...slackOrigin }`. (`_routeKey` `github.pr_<event>`.)
- `pr_review.submitted` / `pr_review_comment.created` → ignore.

**GitHub `comment.created`** (ordered guards, then classify):
1. **Reply-gate short-circuit** — if `db.getPendingReplyGateByTrigger("<repo>#<issueNumber>")` returns a paused run → `explore-reply` *(no workflow; not wired)*. Must sit above mention/maintainer checks.
2. No `@last-light` mention → **ignore**.
3. Mention but author not in `{OWNER,MEMBER,COLLABORATOR}` → **reply** ("maintainers only").
4. `@last-light approve` / `@last-light reject <reason>` regex → `approval-response` *(legacy nudges to the ✅/❌ links)*.
5. `@last-light security-review` regex → `security-review` *(not wired)*.
6. Else classify (`classifyComment` + `screenForInjection` in parallel; flagged text gets a `flagPrefix`):
   - On a **PR** (`prNumber` set): `build` → `pr-fix` *(not wired)*, else `pr-comment` *(not wired)*.
   - On an **issue** with `security-scan` label → `security-feedback` *(not wired)*.
   - Else: `build` → **`github-orchestrator`** (= **`build`** workflow), `explore` → `explore` *(not wired)*, else `issue-comment` *(not wired)*.

**Slack `message`**:
1. Reply-gate short-circuit on `slack:<team>:<channel>:<thread>` → `explore-reply` *(not wired)*.
2. Classify + screen. Intents → `reset`/`status`/`approve`/`reject` *(replies/nudges)*; `build` → managed-repo-gated **`build`** workflow (no repo → fall through to chat); `triage`/`review`/`security`/`explore` → managed-repo-gated targets *(only `review`→pr-review and `build`→build are wired; others reply)*; default → **chat** agent.

**`dispatchSkill` extras**: `splitRepo`, `prNumber ?? issueNumber`, `slackOrigin` (re-derives `{slackChannel, slackThread}` from `envelope.raw`) threaded into `inputData`; `pr-review` posts a "🛠️ reviewing…" Slack ack; `chat` runs the registered chat agent with Memory `{thread, resource}`; unimplemented skills reply "🚧 … M6" for user-initiated events, else log+skip.

**What's actually wired to a workflow/agent today:** `pr-review` (workflow), `build` (workflow, via `github-orchestrator`), `chat` (agent). Everything else is a placeholder reply. **Decision for Phase 11: only port the wired targets as real `workflow`/`agent` contributions; represent the rest as explicit `reply`/`ignore` (or omit) rather than carrying dead skill names.** This is a simplification the "clean cutover" freedom allows — revisit when those workflows are actually built (issue-triage, pr-fix, explore, security-*).

## Target design

### 1. Data-driven classifier in the host
Add a classifier step to the host dispatch. The classifier prompt is **assembled from
the merged `MacClassifierIntent[]`** (each intent's `id` / `description` / `examples`)
plus a base template — no hardcoded enum. Contract (in `@nearform/mac/core`, types only):

```ts
export interface MacClassification {
  intentId: string | null;          // matched intent id, or null → no intent
  repo?: string;
  issueNumber?: number;
  reason?: string;
  flagged?: boolean;                 // injection screener
  flagReason?: string;
}
export interface MacClassifier {
  classify(text: string, ctx?: { issueTitle?: string; isPullRequest?: boolean }): Promise<MacClassification>;
}
```

- The host's `dispatch`, for events that need classification (see routing pipeline
  below), calls the classifier, then finds the `MacClassifierIntent` whose `id ===
  intentId`, applies its `requires` (repo/issueNumber/maintainer) and runs its
  `target` with a `RouteContext` carrying `{ envelope, classification, routeKey:
  "<source>.<intentId>" }`.
- **Where the impl lives (env boundary):** the LLM classifier reads provider keys, so
  it must NOT live in `/core`. Provide a default factory in the **preset layer**
  (`@nearform/mac` root), e.g. `createLlmClassifier({ model, intents, callLlm? })`,
  and let the app inject it (or a custom one) via `MacRoutingConfig.classifier.classify`.
  Port `engine/classifier.ts` (prompt-assembly + `extractGithubRefFromText`),
  `engine/screen.ts` (injection screener + `flagPrefix`/`wrapUntrusted` + untrusted
  markers), and `engine/llm.ts` (`callLlm`/`defaultFastModel`/`resolveProvider`) into
  `@nearform/mac` as the default classifier's internals. Keep env reads in a clearly
  named `*FromEnv` seam (e.g. `defaultFastModel()` / `callLlm` resolve keys) — the
  documented exception to "no env in packages."
- Extend `MacRoutingConfig.classifier` to `{ classify?: MacClassifier; extraIntents?: MacClassifierIntent[] }`.
  If `classify` is omitted but intents exist and a model is set, the host builds the
  default LLM classifier from the catalogue.

### 2. Routing pipeline in `mac.dispatch`
Generalize the host dispatch from "match contributions" to an ordered pipeline:
1. **Pre-rules** (deterministic, high priority): reply-gate short-circuit, mention
   gate, maintainer gate, approval/security regex. Express as `MacRouteContribution`s
   with `when(ctx)` predicates and priority, OR as a small built-in guard list the
   host runs first. The reply-gate needs a lookup — inject a `replyGate?:
   (triggerId) => { workflowRunId } | undefined` via `MacAppConfig` (the old
   `RouterDb`), platform-neutral.
2. **Deterministic event match** — contributions with `eventTypes` (e.g.
   `pr.opened` → pr-review). Run target directly, no classifier.
3. **Classifier match** — for events that fall through (GitHub comment with a
   maintainer mention, Slack message), run the classifier and dispatch the winning
   intent's target. Apply intent `requires` (managed-repo, maintainer, repo presence)
   → on failure, the intent/route can carry a `reply` fallback (or the host emits a
   default "which repo?" style reply). Managed-repo check is injected (`isManagedRepo`)
   or carried in platform metadata (`github.metadata.managedRepos` /
   `slack.metadata.allowedUsers`).
4. **Input shaping** lives in each target's `input(ctx)` callback (replacing
   `dispatchSkill`): `splitRepo`, `prNumber ?? issueNumber`, `slackOrigin(envelope)`.
   Provide a couple of small shared helpers (`splitRepo`, `slackOriginFromEnvelope`)
   in `@nearform/mac/core` since both platforms use them.

### 3. Contributions from extensions
Move the route/intent catalogue into the extensions that own the targets:
- **`workflows({ use })`** (`@nearform/mac-agent-workflows`) contributes:
  - `pr-review`: a deterministic GitHub PR-attention route (`eventTypes: ["pr.opened","pr.synchronize","pr.reopened"]`, `input` shaping owner/repo/number+slackOrigin) **and** a `REVIEW` classifier intent (Slack "review <repo>", managed-repo-gated).
  - `build`: a `BUILD` classifier intent (Slack "build <repo>#n" and GitHub issue-comment build), managed-repo + (for comments) maintainer-gated, `input` shaping `{owner,repo,issueNumber,issueTitle,issueBody,baseBranch:"main",...slackOrigin}`.
- **`agents({ use })`** contributes the `chat` agent route + a `CHAT` default/fallback intent (already does a minimal version).
- The host merges these with `routing.add` / `overrideTargets` / `extraIntents` exactly as today.
- Pre-rule guards (mention/maintainer/approval/security/reply-gate) are **GitHub-specific** → contribute them from the `github()` extension (or a small built-in GitHub guard set the github extension returns as high-priority `MacRouteContribution`s with `when`).

## Work items

1. **Core contracts**: add `MacClassifier`/`MacClassification`, extend `RouteContext`
   (already has `classification`), extend `MacRoutingConfig.classifier` with
   `classify?`/`replyGate?`/`isManagedRepo?` seams; add shared `splitRepo` +
   `slackOriginFromEnvelope` helpers. (`packages/mac/src/core/`.)
2. **Default classifier** in `@nearform/mac` (preset layer): port
   `classifier.ts`+`screen.ts`+`llm.ts`; `createLlmClassifier({model,intents})` that
   assembles the prompt from the catalogue and runs classify+screen in parallel.
3. **Host dispatch pipeline**: rewrite `mac.dispatch` (`create-mac-app.ts`) into the
   pre-rules → deterministic → classifier pipeline; wire the injected
   `classify`/`replyGate`/`isManagedRepo`; build the default classifier from the
   merged intents when none injected. Preflight intent targets (already done).
4. **Extension contributions**: enrich `workflows({use})` and the `github()` extension
   to contribute the deterministic routes, classifier intents, and GitHub guard rules
   listed above. Decide the simplification: unwired skills → omit or `reply`.
5. **App cutover** (`apps/maintenance`): point `createGithubWebhookRoute` and
   `startSlackConnector` at `mac.dispatch` (thread `mac.dispatch` out of `buildPreset`
   into `server.ts`/the webhook route); pass `routing.classifier`/`replyGate`/
   `isManagedRepo` config into `createMacApp`. **Delete** `engine/dispatch.ts`,
   `engine/router.ts`, `engine/classifier.ts`, `engine/screen.ts`, `engine/llm.ts`,
   `managed-repos.ts` (or move managed-repos into config), and the app router test.
6. **Tests**: rewrite `apps/maintenance/test/router.test.ts` as host-dispatch tests
   (`packages/mac/test/dispatch-router.test.ts`) driving `mac.dispatch` with a **mocked
   classifier** and fake workflow/agent targets recording calls — assert: PR-attention
   → pr-review with shaped input; mention/maintainer gate; approval/security regex;
   managed-repo gating; Slack build/review/chat; reply-gate short-circuit;
   `extraIntents` + intent `overrideTargets` now actually fire. Add a unit test for the
   prompt-assembly (catalogue → prompt contains each intent's description/examples).

## Acceptance
- `mac.dispatch` is the only router; `engine/{dispatch,router,classifier,screen,llm}.ts`
  and `managed-repos.ts` deleted; webhook + Slack call `mac.dispatch`.
- Default classifier prompt is assembled from the intent catalogue (grep: no hardcoded
  intent enum in the routing path); `routing.classifier.extraIntents` and intent-keyed
  `overrideTargets` demonstrably route (covered by tests).
- The wired targets (pr-review, build, chat) route with correct shaped input; gates
  (mention/maintainer/managed-repo/reply-gate) enforced.
- `pnpm -r typecheck` + `pnpm test` green; env reads only in the named classifier
  `*FromEnv` seam (host/preset layer), none in `/core` or the workflow/agent packages.

## Open decisions (resolve when executing)
- **Classifier home**: default impl in `@nearform/mac` root (preset) with app-injectable
  override — vs. a separate `@nearform/mac-llm` package. Lean preset-layer for now.
- **Unwired skills**: omit vs. explicit `reply` contributions. Lean omit + a single
  catch-all `reply` for mentioned-but-unroutable, to avoid carrying dead skill names.
- **Managed-repo source**: injected `isManagedRepo` fn vs. reading
  `github.metadata.managedRepos` from the capability. Lean on the capability metadata
  (already published by `github()`), falling back to an injected fn for non-GitHub.
- **Pre-rule guards**: model as priority `when` contributions vs. a dedicated built-in
  guard phase in the host. Lean built-in guard phase for the GitHub mention/maintainer/
  reply-gate trio (hard to express purely as `when` without ordering subtleties).
