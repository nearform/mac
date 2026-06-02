import { describe, it, expect } from "vitest";
import { agents } from "../src/index.js";

/**
 * Regression guard: the `agents()` selector must thread `maxSteps` into the
 * coding agents' `defaultOptions`. Before this was wired, `maxSteps` was only
 * honored on the bare-factory path and silently dropped on the createMacApp
 * (host) path, pinning every agent to the factory default (40).
 *
 * The selector also tolerates a MISSING GitHub platform (github is declared
 * `optional`), so `init` runs with a capabilities stub whose `optional()`
 * returns undefined — exercising the no-op read-tools fallback too.
 */

// Minimal capabilities stub: only `optional()` is exercised by agents().init,
// and it returns undefined (no GitHub configured).
const capabilitiesStub = {
  optional: () => undefined,
  require: () => {
    throw new Error("not used");
  },
  has: () => false,
  provide: () => {},
} as unknown as Parameters<ReturnType<typeof agents>["init"]>[0]["capabilities"];

const fakeContext = {
  model: "openai/gpt-4o",
  workspaceFactory: { create: () => ({}) as never },
  dispatch: async () => undefined,
  capabilities: capabilitiesStub,
};

async function maxStepsOf(agent: unknown): Promise<number | undefined> {
  const opts = await (agent as { getDefaultOptions(): Promise<{ maxSteps?: number }> }).getDefaultOptions();
  return opts.maxSteps;
}

describe("agents() selector — maxSteps threading", () => {
  it("applies the configured maxSteps to a coding agent", async () => {
    const result = await agents({ use: ["reviewer"], maxSteps: 7 }).init(fakeContext);
    expect(await maxStepsOf(result.agents!.reviewer)).toBe(7);
  });

  it("falls back to the factory default (40) when maxSteps is unset", async () => {
    const result = await agents({ use: ["reviewer"] }).init(fakeContext);
    expect(await maxStepsOf(result.agents!.reviewer)).toBe(40);
  });

  it("constructs coding agents even when GitHub is absent (optional capability)", async () => {
    const result = await agents({
      use: ["reviewer", "architect", "executor"],
    }).init(fakeContext);
    expect(Object.keys(result.agents ?? {})).toEqual(["reviewer", "architect", "executor"]);
  });
});
