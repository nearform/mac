import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Dependency-cycle guard for the MAC package set (Phase 10).
 *
 * Reads the four `@nearform/*` package.json files, builds the internal
 * dependency graph from their `dependencies` (only `@nearform/*` edges count),
 * and asserts:
 *   (a) the internal graph is ACYCLIC (DFS cycle detector below), and
 *   (b) `@nearform/mac` is a sink: it has NO `@nearform/*` runtime dependency
 *       (the host/core never depends on a platform/agent package; lower
 *       packages depend on it, not the other way round).
 * It also asserts every package.json exposes an `exports` map with a `.` entry
 * and the documented subpaths (`mac` → `./core`; the platform packages +
 * agent-workflows → `./capabilities`).
 *
 * Pure: no installs, no network. Reads files relative to this test via
 * `import.meta.url`.
 */

const here = dirname(fileURLToPath(import.meta.url));
// packages/mac/test → packages
const packagesDir = join(here, "..", "..");

const PACKAGE_DIRS: Record<string, string> = {
  "@nearform/mac": "mac",
  "@nearform/mac-github": "mac-github",
  "@nearform/mac-slack": "mac-slack",
  "@nearform/mac-agent-workflows": "mac-agent-workflows",
};

interface Pkg {
  name: string;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

function readPkg(dir: string): Pkg {
  const raw = readFileSync(join(packagesDir, dir, "package.json"), "utf8");
  return JSON.parse(raw) as Pkg;
}

const pkgs = Object.fromEntries(
  Object.entries(PACKAGE_DIRS).map(([name, dir]) => [name, readPkg(dir)]),
) as Record<string, Pkg>;

const NAMES = Object.keys(PACKAGE_DIRS);

/** Internal dependency graph: name → list of in-scope @nearform/* deps. */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const name of NAMES) {
    const deps = pkgs[name].dependencies ?? {};
    const edges = Object.keys(deps).filter(
      (d) => NAMES.includes(d) && d !== name,
    );
    graph.set(name, edges);
  }
  return graph;
}

/** Small DFS cycle detector. Returns the offending path, or null if acyclic. */
function findCycle(graph: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.keys()) color.set(n, WHITE);

  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (color.get(next) === GRAY) {
        // Back edge → cycle. Slice the stack from where `next` re-enters.
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (color.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return null;
  };

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

describe("MAC internal dependency graph", () => {
  it("is acyclic (no @nearform/* dependency cycles)", () => {
    const graph = buildGraph();
    const cycle = findCycle(graph);
    expect(
      cycle,
      cycle ? `dependency cycle: ${cycle.join(" -> ")}` : undefined,
    ).toBeNull();
  });

  it("@nearform/mac is a sink — no @nearform/* runtime dependency", () => {
    const graph = buildGraph();
    expect(graph.get("@nearform/mac")).toEqual([]);
  });

  it("the DAG matches the documented direction (mac is the sink/near-sink)", () => {
    const graph = buildGraph();
    // Platform packages depend on mac (core) only.
    expect(graph.get("@nearform/mac-github")).toEqual(["@nearform/mac"]);
    expect(graph.get("@nearform/mac-slack")).toEqual(["@nearform/mac"]);
    // agent-workflows depends on mac + both platform packages (the
    // key-only/type-only edge to their dependency-light /capabilities surface).
    expect(new Set(graph.get("@nearform/mac-agent-workflows"))).toEqual(
      new Set([
        "@nearform/mac",
        "@nearform/mac-github",
        "@nearform/mac-slack",
      ]),
    );
    // Nothing depends on agent-workflows (it is the source/top of the DAG).
    for (const name of NAMES) {
      expect(graph.get(name)).not.toContain("@nearform/mac-agent-workflows");
    }
  });

  it("each package has an exports map with a '.' entry", () => {
    for (const name of NAMES) {
      const exp = pkgs[name].exports;
      expect(exp, `${name} must declare exports`).toBeTruthy();
      expect(
        exp && Object.prototype.hasOwnProperty.call(exp, "."),
        `${name} must export the '.' root entry`,
      ).toBe(true);
    }
  });

  it("exposes the documented subpaths (/core, /capabilities)", () => {
    const has = (name: string, sub: string) =>
      Object.prototype.hasOwnProperty.call(pkgs[name].exports ?? {}, sub);

    expect(has("@nearform/mac", "./core")).toBe(true);
    expect(has("@nearform/mac-github", "./capabilities")).toBe(true);
    expect(has("@nearform/mac-slack", "./capabilities")).toBe(true);
    expect(has("@nearform/mac-agent-workflows", "./capabilities")).toBe(true);
  });
});
