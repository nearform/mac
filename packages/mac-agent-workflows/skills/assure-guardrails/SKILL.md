---
name: assure-guardrails
description: >
  Pre-flight check before implementation work. Verifies a repo has the foundational
  dev guardrails (test framework, linting, type checking) the build cycle depends on,
  and reports a READY / BLOCKED verdict the workflow uses to gate.
version: 1.0.0
license: MIT
tags: [guardrails, pre-flight, testing, linting, quality, workflow]
related_skills: [architect, test-driven-development]
---

# Assure Guardrails

## Purpose

The build cycle depends on foundational tooling: TDD needs a test framework, the
requesting-code-review pipeline needs linting and type checking, the Reviewer needs
tests to run. If any of these are missing, implementation work will either skip
quality checks or fail at verification.

This skill runs **after cloning a repo and reading its docs**, but **before the
Architect phase**. It checks the foundations and reports a verdict. You only produce
the report and the READY / BLOCKED verdict — the build workflow reads it and decides
whether to gate (it does not expect you to create issues or push).

**Core principle:** You cannot build reliably on a repo without tests, linting, and
type checking. Fix the foundations first, then build features.

## When to Run

Run this check:
- Before any build request (Architect→Executor→Reviewer cycle)
- Before any test coverage analysis
- Before any planned implementation work on a managed repo
- Skip for: pure documentation changes, issue triage, PR reviews, health reports

## What to Check

After cloning the repo and reading `CLAUDE.md`/`AGENTS.md`, verify these guardrails:

### 1. Test Framework

**Check for:**
- Test runner config (`vitest.config.*`, `jest.config.*`, `pytest.ini`, `pyproject.toml [tool.pytest]`, `Cargo.toml [dev-dependencies]`, etc.)
- Test script in `package.json` (`scripts.test`) or equivalent
- At least one test file exists (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`)
- Tests actually run: execute the test command and confirm it doesn't error

**If missing:** The repo has no test framework. TDD is impossible. This is a blocker.

### 2. Linting

**Check for:**
- Linter config (`.eslintrc*`, `biome.json`, `.ruff.toml`, `ruff.toml`, `.flake8`, `clippy` in Cargo)
- Lint script in `package.json` (`scripts.lint`) or equivalent
- Linter actually runs without crashing

**If missing:** Code quality checks in the review pipeline will be skipped.

### 3. Type Checking

**Check for:**
- TypeScript: `tsconfig.json` and a typecheck script (`tsc --noEmit`)
- Python: `mypy.ini`, `pyproject.toml [tool.mypy]`, or `pyrightconfig.json`
- Rust: built-in (cargo check)
- Go: built-in (go vet)

**If missing:** Type errors won't be caught before merge.

### 4. CI Pipeline (informational, not blocking)

**Check for:**
- `.github/workflows/` with test/lint/typecheck steps
- Or equivalent CI config (`.gitlab-ci.yml`, `Jenkinsfile`, etc.)

**If missing:** Note it as a recommendation but don't block on it.

## Detection by Language

Use the repo's `CLAUDE.md` first — it often documents the exact commands. Fall back to
auto-detection only if docs don't cover it.

### JavaScript / TypeScript
```bash
# Test framework
cat package.json | grep -E '"test"'
ls vitest.config.* jest.config.* 2>/dev/null
find . -name '*.test.*' -o -name '*.spec.*' | head -5

# Linting
cat package.json | grep -E '"lint"'
ls .eslintrc* biome.json 2>/dev/null

# Type checking
ls tsconfig.json 2>/dev/null
cat package.json | grep -E '"typecheck"|"tsc"'
```

### Python
```bash
# Test framework
ls pytest.ini setup.cfg pyproject.toml 2>/dev/null
grep -l pytest pyproject.toml setup.cfg 2>/dev/null
find . -name 'test_*.py' -o -name '*_test.py' | head -5

# Linting
ls .ruff.toml ruff.toml .flake8 2>/dev/null

# Type checking
ls mypy.ini pyrightconfig.json 2>/dev/null
grep -l mypy pyproject.toml 2>/dev/null
```

### Rust
```bash
# Tests are built-in (cargo test)
grep '\[dev-dependencies\]' Cargo.toml
# Linting is built-in (cargo clippy)
# Type checking is built-in (cargo check)
```

## Output Format

Produce a guardrails report:

```markdown
## Guardrails Report: {repo}

### Test Framework
- Status: PRESENT / MISSING / BROKEN
- Runner: {vitest / jest / pytest / cargo test / ...}
- Command: {npm test / pytest / ...}
- Test count: {N tests found}
- Notes: {any issues}

### Linting
- Status: PRESENT / MISSING / BROKEN
- Tool: {biome / eslint / ruff / clippy / ...}
- Command: {npm run lint / ...}
- Notes: {any issues}

### Type Checking
- Status: PRESENT / MISSING / BROKEN
- Tool: {tsc / mypy / cargo check / ...}
- Command: {npm run typecheck / ...}
- Notes: {any issues}

### CI Pipeline
- Status: PRESENT / MISSING
- Notes: {what it covers}

### Verdict: READY / BLOCKED
```

## When Guardrails Are Missing

If any of tests, linting, or type checking are **MISSING** or **BROKEN**, say so in
the report and decide the verdict:

- **BLOCKED** — no test framework at all, or tests are completely broken. TDD is
  impossible and the reviewer has nothing to run. This is the hard blocker.
- **READY (with notes)** — linting or type checking is missing but tests work. Call
  the gaps out under Notes; they degrade the review pipeline but don't make the build
  impossible.

You do **not** file issues, link tasks, or push fixes — emit the report and the
verdict, then stop. The build workflow owns what happens next: a BLOCKED verdict
aborts the build (unless it was started in `bootstrap` mode, where setting up the
missing tooling IS the task), and your report is committed as a build artifact for
the operator to read.

## Integration with the Build Cycle

In the MAC build workflow this is the first step — it runs after the deterministic
clone + dependency install (both workflow-owned), before the architect step:

```
clone + install deps (workflow-owned)
    ↓
GUARDRAILS CHECK (this skill)
    ↓
  READY   → architect → executor → review/fix loop → PR
  BLOCKED → build aborts (unless started in bootstrap mode)
```
