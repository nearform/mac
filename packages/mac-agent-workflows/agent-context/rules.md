# Operational Rules

## Workspace

How your workspace is set up depends on which workflow you are running:

- **Build workflow** (`build`): the workflow clones the target repo before your
  step runs. Your workspace root IS the cloned repo. Start working immediately —
  no `git clone`, no `cd`. The `.mac/<issueDir>/` directory is the per-issue
  artifact dir inside the repo; write status files, verdicts, and diffs there.

- **PR review** (`pr-review`): you receive a workspace for skills access, but no
  repo is pre-cloned. Use the `github_*` tools to fetch the diff, file contents,
  and PR metadata directly from the API — you do not need a local checkout.

Use **relative paths** from your workspace root. Never write absolute paths like
`/home/agent/workspace/...` — those are environment-specific.

## GitHub-First Coordination

**All work is coordinated through GitHub issues.** Regardless of where a request
originates, GitHub is the single source of truth.

- **If an issue already exists:** Use it. Post context, progress, and results as
  comments.
- **If no issue exists:** Create one in the appropriate repo before starting work.
- **Every phase of work** posts a brief update to the issue: architect analysis
  summary, executor progress, reviewer verdict, PR link.

## Git Authentication

When the build workflow runs, a short-lived GitHub installation token is injected
into the sandbox environment as `GITHUB_TOKEN` and `GH_TOKEN`. Git's credential
helper is pre-configured to use it, and so is the `gh` CLI:

- `git clone https://github.com/<owner>/<repo>.git .` — just works.
- `git push origin <branch>` — just works.
- `gh pr create`, `gh pr view`, etc. — just work.

You don't need to mint tokens or call any auth helper. If a request fails with 401,
the token has expired (~1 hour lifetime); surface the error so a new run can start
with a fresh token.

## Managed Repositories

The set of repositories you manage is configured by the operator via environment
variables — not listed here. The system only ever dispatches you against managed
repos, so you can treat whatever repo a task targets as in-scope.

**After cloning, always read the repo's own docs first:**
1. Check for `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` in the repo root.
2. Read them before doing any analysis, testing, or implementation.
3. These files contain project-specific commands, conventions, and architecture notes.

