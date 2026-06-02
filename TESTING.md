# Testing the spike locally

## Start the app (server + Studio)

```bash
corepack pnpm dev   # (or: corepack pnpm -C apps/server dev)
# Studio UI:   http://localhost:4111
# REST API:    http://localhost:4111/api
# OpenAPI:     http://localhost:4111/openapi.json   (Swagger: /swagger-ui)
```

`apps/server/.env` already carries the model key + GitHub App config. The
GitHub App PEM lives at `secrets/app.pem` (gitignored).

---

## M2 — Chat agent

**Studio:** open http://localhost:4111 → Agents → `chat` → chat with it
("look up issue cliftonc/lastlight#1").

**curl:**
```bash
curl -s http://localhost:4111/api/agents/chat/generate \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Look up issue #1 in cliftonc/lastlight and give its title and state."}]}' | jq -r '.text'
```

---

## M3 — pr-review workflow (posts ONE real PR review)

> Posts a real review to the PR you name — only run against a PR you're happy for
> the bot to comment on, on a repo the GitHub App is installed on.

**Studio (easiest):** http://localhost:4111 → Workflows → `pr-review` → Run, with input:
```json
{ "owner": "cliftonc", "repo": "lastlight", "number": 123 }
```

**curl (two calls — create a run, then start it):**
```bash
WF=pr-review
RUN=$(curl -s -X POST http://localhost:4111/api/workflows/$WF/create-run | jq -r '.runId')
curl -s -X POST http://localhost:4111/api/workflows/$WF/runs/$RUN/start \
  -H 'content-type: application/json' \
  -d '{"inputData":{"owner":"cliftonc","repo":"lastlight","number":123}}' | jq
```
(Or the one-shot shortcut: `POST /api/workflows/pr-review/start-async` with the same
`{"inputData":{...}}` body.)

The agent fetches the PR diff, reasons, and posts exactly one review
(APPROVE / REQUEST_CHANGES / COMMENT) via the `github_post_review` tool using a
`review-write`-scoped installation token. The result's `summary` is the review text.

---

## Sandbox sanity (M3 plumbing)

```bash
curl -s http://localhost:4111/api/agents/sandboxProbe/generate \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Run: echo hi && pwd"}]}' | jq -r '.text'
```
Confirms the agent runs shell in the LocalSandbox via `mastra_workspace_execute_command`.
(LocalSandbox = host execution, no isolation/egress firewall yet — deferred.)
