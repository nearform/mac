# @nearform/mac-github

GitHub platform package for **MAC** (Mastra Agentic Coding). Owns GitHub App
authentication, permission profiles, Octokit factories, read/write Mastra tools,
issue/PR helpers, and the `github()` extension for `createMacApp`.

## Entry points

| Import | Contents | Weight |
| --- | --- | --- |
| `@nearform/mac-github` | `github()` extension, tools, auth, Octokit clients, issue/PR helpers — the full runtime API. | pulls Octokit |
| `@nearform/mac-github/capabilities` | `GithubCapabilities` + the `githubCapabilities` key — the type-only contract. | dependency-light (no Octokit at import) |

Agent/workflow packages should `import type { GithubCapabilities }` and
`import { githubCapabilities }` from `/capabilities` so they never pull Octokit,
webhook crypto, or env loaders transitively.

## The `github()` extension

```ts
import { github } from "@nearform/mac-github";

const platform = github({
  appId: process.env.GITHUB_APP_ID!,
  installationId: process.env.GITHUB_APP_INSTALLATION_ID!,
  privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH!,
  managedRepos: ["nearform/example-repo"],
  botLogin: "mac",
});
// Pass `platform` to createMacApp({ platforms: [platform] }) (Phase 6).
```

During `init` it publishes a configured `GithubCapabilities` bundle into the
capability registry under the `githubCapabilities` key:

- `tools.createReadTools({ token })` / `tools.createReviewTools({ token })`
- `functions.tokenBroker.mint(profile)` — the **only** way reusable workflow
  code obtains a scoped installation token
- `functions.createOctokit({ token })`, `functions.replyOnIssue(...)`,
  `functions.postPullRequestReview(...)`, `functions.addIssueComment(...)`, …
- `metadata.managedRepos`, `metadata.botLogin`

The inbound webhook route (`servers`/`createGithubWebhookRoute`) is added in
Phase 3.

## Permission profiles (the security boundary)

`mintTokenForProfile(appConfig, profile)` mints an installation token downscoped
to one of `read` | `issues-write` | `review-write` | `repo-write`. A triage
agent literally cannot push code because its token has `contents: read`.

## Low-level building blocks

Read tools and write helpers are exported separately so callers opt into write
scope intentionally:

```ts
import {
  createGithubReadTools,        // read-only Mastra tools
  createGithubReviewTools,      // review-submission tool (write)
  postPullRequestReview,        // deterministic review post
  addIssueComment, updateIssueComment, addIssueReaction,
  createTokenOctokit, createInstallationOctokit,
  mintTokenForProfile, resolveProfile,
} from "@nearform/mac-github";
```
