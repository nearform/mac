/**
 * Managed-repo allowlist. The GitHub App may be installed on extra repos, but we
 * only operate on those we explicitly manage.
 *
 * Ported from lastlight `src/managed-repos.ts`, adapted for the Mastra spike:
 * lastlight read the list from its layered YAML config (config/default.yaml +
 * overlay). The spike dropped that overlay (see MIGRATION.md), so the list comes
 * from `LASTLIGHT_MANAGED_REPOS` — a comma-separated `owner/repo` list in `.env`.
 */

function parseManagedRepos(): string[] {
  const raw = process.env.LASTLIGHT_MANAGED_REPOS ?? "";
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

export function getManagedRepos(): string[] {
  return parseManagedRepos();
}

export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return getManagedRepos().includes(repo);
}
