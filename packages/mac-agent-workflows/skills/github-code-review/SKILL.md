---
name: github-code-review
description: Review a code change (a PR diff or a working-tree diff) for correctness, security, quality, testing, performance, and docs. Produces a structured verdict; does not post it.
version: 2.0.0
license: MIT
tags: [code-review, pull-requests, quality, security]
related_skills: [codebase-inspection]
---

# Code Review

Review a change with a critical, evidence-based eye and produce a **verdict plus a
review body**. You do **not** post the review yourself — in the MAC workflows the
reviewer agent emits the verdict and the workflow posts it deterministically. Your job
is the judgement, not the API call.

## Output contract

Your response MUST begin with a single verdict line, then the markdown review body:

```
VERDICT: APPROVE | REQUEST_CHANGES | COMMENT
<review body in markdown>
```

- **APPROVE** — no critical or warning-level issues; only minor suggestions, or all clear.
- **REQUEST_CHANGES** — any critical or warning-level issue that should be fixed before merge.
- **COMMENT** — observations and suggestions, nothing blocking (use when unsure or for a draft).

## Getting the change

You have read tools and a sandbox checkout. Work from the diff:

```bash
# Scope first
git diff main...HEAD --stat
git log main..HEAD --oneline

# The actual change
git diff main...HEAD
# Or file-by-file for large changes
git diff main...HEAD --name-only
git diff main...HEAD -- path/to/file
```

For a PR, the diff may already be supplied in your prompt; otherwise fetch it with your
read tools. Always read the surrounding code for changed files — a diff alone hides
issues only visible with full context.

## Fast heuristic scan

Cheap greps over the added lines surface obvious problems before the careful read:

```bash
# Debug leftovers
git diff main...HEAD | grep -nE "console\.log|debugger|print\(|TODO|FIXME|XXX"
# Secret-shaped literals
git diff main...HEAD | grep -inE "password|secret|api_key|token\s*=|private_key"
# Merge-conflict markers
git diff main...HEAD | grep -nE "<<<<<<<|=======|>>>>>>>"
```

## Review checklist

### Correctness
- Does the code do what it claims?
- Edge cases handled (empty inputs, nulls, large data, concurrency)?
- Error paths handled gracefully?

### Security
- No hardcoded secrets, credentials, or API keys
- Input validation on user-facing inputs
- No SQL injection, XSS, path traversal, or shell injection on attacker-influenced args
- Auth/authz checks where needed

### Code Quality
- Clear naming; no unnecessary complexity or premature abstraction
- DRY — no duplicated logic that should be extracted
- Functions focused (single responsibility)

### Testing
- New code paths covered? Happy path and error cases?
- Tests verify behavior, not implementation; readable and maintainable

### Performance
- No N+1 queries or needless loops; appropriate caching
- No blocking operations in async paths

### Documentation
- Public APIs documented; non-obvious logic explains "why"
- README/docs updated if behavior changed

## Review body format

```markdown
## Code Review Summary

### 🔴 Critical
- **src/auth.py:45** — SQL injection: user input concatenated into the query. Use parameterized queries.

### ⚠️ Warnings
- **src/models/user.py:23** — Password stored in plaintext. Hash with bcrypt/argon2.

### 💡 Suggestions
- **src/utils/helpers.py:8** — Duplicates `src/core/utils.py:34`. Consolidate.

### ✅ Looks Good
- Clean separation of concerns in the middleware layer
- Good happy-path test coverage
```

Cite `file:line` for every finding. Ground each claim in code you actually read — never
generic advice. If a section has nothing, omit it (but always justify the verdict).
