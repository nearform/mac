# packages/mac-github

GitHub App auth, permission profiles, Octokit factories, Mastra tools (read + write),
webhook connector, and the `github()` extension that wires it all together.

## Key conventions

- **Permission profiles are curated.** Never request wildcard scopes. Use the
  predefined profiles in `src/profiles.ts` (`pull-request-review`, `issues-write`,
  etc.) via `mintTokenForProfile`.
- **`src/capabilities.ts` is type-only.** It has no Octokit imports and no env reads —
  other packages import from here to stay lightweight. Runtime code lives elsewhere.
- **Webhook normalization** (`src/webhook.ts`) rejects requests with an invalid
  signature and silently filters bot self-events by `botLogin`. Do not bypass either
  check.
- **Tools vs functions:** `createGithubReadTools` / `createGithubReviewTools` return
  Mastra `Tool` objects for agent step use. `addIssueComment` etc. in
  `src/issue-tools.ts` are deterministic helpers for workflow steps — not tool calls.

## Tests

`test/` covers webhook signature verification and payload normalization. Run with
`pnpm test`.
