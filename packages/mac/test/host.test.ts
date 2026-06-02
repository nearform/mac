import { describe, it, expect } from "vitest";
import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";

import { createMacApp } from "../src/index.js";
import type { MacAppConfig } from "../src/index.js";
import {
  capabilityKey,
  defineAgent,
  defineWorkflow,
  type EventEnvelope,
  type MacCapabilityKey,
  type MacExtension,
  type MacExtensionContext,
  type MacExtensionResult,
} from "../src/core/index.js";

// --- Fakes -----------------------------------------------------------------

/** A fake Agent — only `generate` is exercised by dispatch tests. */
function fakeAgent(record?: (input: unknown) => void): Agent {
  return {
    generate: async (input: unknown) => {
      record?.(input);
      return { text: "ok" };
    },
  } as unknown as Agent;
}

/** A fake Workflow that records createRun().start() calls. */
function fakeWorkflow(calls: Array<{ input: unknown }>): Workflow {
  return {
    createRun: async () => ({
      start: async (args: { inputData: unknown }) => {
        calls.push({ input: args.inputData });
        return { status: "success" };
      },
    }),
  } as unknown as Workflow;
}

const baseConfig: MacAppConfig = { model: "test/model" };

// --- Capability keys for fake extensions -----------------------------------

const fooCap = capabilityKey<{ value: string }>("foo", "Foo platform");
const barCap = capabilityKey<{ value: string }>("bar", "Bar platform");

/** A platform extension that provides `key` with a recorded value. */
function providerExt(
  name: string,
  key: MacCapabilityKey<{ value: string }>,
  order: string[],
  result: MacExtensionResult = {},
): MacExtension {
  return {
    name,
    provides: [key],
    init(ctx: MacExtensionContext): MacExtensionResult {
      order.push(name);
      ctx.capabilities.provide(key, { value: name });
      return result;
    },
  };
}

/** A consumer extension that requires `key` and asserts it sees the provided value. */
function consumerExt(
  name: string,
  key: MacCapabilityKey<{ value: string }>,
  order: string[],
  seen: { value?: string },
  result: MacExtensionResult = {},
): MacExtension {
  return {
    name,
    requires: [key],
    init(ctx: MacExtensionContext): MacExtensionResult {
      order.push(name);
      seen.value = ctx.capabilities.require(key).value;
      return result;
    },
  };
}

// --- Tests -----------------------------------------------------------------

describe("createMacApp — topological ordering", () => {
  it("runs a provider before a consumer regardless of input order", async () => {
    const order: string[] = [];
    const seen: { value?: string } = {};
    // Consumer listed FIRST in config, but must run AFTER its provider.
    await createMacApp({
      ...baseConfig,
      platforms: [
        consumerExt("consumer", fooCap, order, seen),
        providerExt("provider", fooCap, order),
      ],
    });
    expect(order).toEqual(["provider", "consumer"]);
    expect(seen.value).toBe("provider");
  });
});

describe("createMacApp — cycle detection", () => {
  it("throws on a dependency cycle", async () => {
    // a provides foo, requires bar; b provides bar, requires foo.
    const a: MacExtension = {
      name: "a",
      provides: [fooCap],
      requires: [barCap],
      init: (ctx) => {
        ctx.capabilities.provide(fooCap, { value: "a" });
        return {};
      },
    };
    const b: MacExtension = {
      name: "b",
      provides: [barCap],
      requires: [fooCap],
      init: (ctx) => {
        ctx.capabilities.provide(barCap, { value: "b" });
        return {};
      },
    };
    await expect(
      createMacApp({ ...baseConfig, platforms: [a, b] }),
    ).rejects.toThrow(/dependency cycle/);
  });
});

describe("createMacApp — missing required capability", () => {
  it("preflights and throws naming the capability id", async () => {
    const order: string[] = [];
    const seen: { value?: string } = {};
    await expect(
      createMacApp({
        ...baseConfig,
        platforms: [consumerExt("needs-foo", fooCap, order, seen)],
      }),
    ).rejects.toThrow(/requires capability "foo \(Foo platform\)"/);
  });
});

describe("createMacApp — duplicate id guard", () => {
  it("throws on a duplicate workflow id without overrides", async () => {
    const wfDef = (id: string) =>
      defineWorkflow({
        id,
        description: id,
        create: () => fakeWorkflow([]),
      });
    await expect(
      createMacApp({
        ...baseConfig,
        workflows: [wfDef("dup"), wfDef("dup")],
      }),
    ).rejects.toThrow(/duplicate workflow id "dup"/);
  });

  it("replaces a workflow when the later definition declares overrides", async () => {
    const first = fakeWorkflow([]);
    const second = fakeWorkflow([]);
    const preset = await createMacApp({
      ...baseConfig,
      workflows: [
        defineWorkflow({ id: "dup", description: "first", create: () => first }),
        defineWorkflow({
          id: "dup",
          description: "second",
          overrides: "dup",
          create: () => second,
        }),
      ],
    });
    expect(preset.workflows.dup).toBe(second);
  });

  it("throws on a duplicate agent id without overrides", async () => {
    const agentDef = (id: string) =>
      defineAgent({ id, description: id, create: () => fakeAgent() });
    await expect(
      createMacApp({
        ...baseConfig,
        agents: [agentDef("dup"), agentDef("dup")],
      }),
    ).rejects.toThrow(/duplicate agent id "dup"/);
  });
});

describe("createMacApp — required agents (transitive)", () => {
  it("throws preflight when a required agent is not registered", async () => {
    const wf = defineWorkflow({
      id: "needs-x",
      description: "needs-x",
      requiredAgents: ["x"],
      create: () => fakeWorkflow([]),
    });
    await expect(
      createMacApp({ ...baseConfig, workflows: [wf] }),
    ).rejects.toThrow(/workflow "needs-x" requires agent "x" which is not registered/);
  });

  it("succeeds when an agent-producing unit registers the required agent", async () => {
    const agentX = defineAgent({
      id: "x",
      description: "x",
      create: () => fakeAgent(),
    });
    const wf = defineWorkflow({
      id: "needs-x",
      description: "needs-x",
      requiredAgents: ["x"],
      create: ({ capabilities }) => {
        // Custom workflow resolves agents via the core registry capability.
        const reg = capabilities.require(
          capabilityKey<{ byId(id: string): Agent }>("agents"),
        );
        expect(reg.byId("x")).toBeDefined();
        return fakeWorkflow([]);
      },
    });
    // Workflow listed before the agent; host orders the agent first.
    const preset = await createMacApp({
      ...baseConfig,
      workflows: [wf],
      agents: [agentX],
    });
    expect(preset.agents.x).toBeDefined();
    expect(preset.workflows["needs-x"]).toBeDefined();
  });
});

describe("createMacApp — approvalLinks threading", () => {
  it("threads config.approvalLinks into a workflow's create context", async () => {
    const seen: { approvalLinks?: unknown } = {};
    const builder = { link: () => "http://approve" };
    const wf = defineWorkflow({
      id: "needs-approval",
      description: "needs-approval",
      create: ({ approvalLinks }) => {
        seen.approvalLinks = approvalLinks;
        return fakeWorkflow([]);
      },
    });
    await createMacApp({
      ...baseConfig,
      approvalLinks: builder,
      workflows: [wf],
    });
    expect(seen.approvalLinks).toBe(builder);
  });
});

describe("createMacApp — route target preflight", () => {
  it("throws when a route target points at a non-existent workflow", async () => {
    const ext: MacExtension = {
      name: "router-ext",
      init: () => ({
        routes: [
          { id: "bad", target: { type: "workflow", id: "ghost" } },
        ],
      }),
    };
    await expect(
      createMacApp({ ...baseConfig, platforms: [ext] }),
    ).rejects.toThrow(/route "bad" references workflow "ghost" which is not registered/);
  });

  it("throws when a classifier intent points at a non-existent agent", async () => {
    const ext: MacExtension = {
      name: "intent-ext",
      init: () => ({
        classifierIntents: [
          {
            id: "GHOST",
            description: "ghost",
            target: { type: "agent", id: "nope" },
          },
        ],
      }),
    };
    await expect(
      createMacApp({ ...baseConfig, platforms: [ext] }),
    ).rejects.toThrow(/classifier intent "GHOST" references agent "nope"/);
  });
});

describe("createMacApp — dispatch", () => {
  it("runs the matched workflow target via createRun().start()", async () => {
    const calls: Array<{ input: unknown }> = [];
    const wf = defineWorkflow({
      id: "build",
      description: "build",
      create: () => fakeWorkflow(calls),
    });
    const routeExt: MacExtension = {
      name: "routes",
      init: () => ({
        routes: [
          {
            id: "gh.pr",
            source: "github",
            eventTypes: ["pr.opened"],
            target: {
              type: "workflow",
              id: "build",
              input: (ctx) => ({ repo: ctx.envelope.repo }),
            },
          },
        ],
      }),
    };
    const preset = await createMacApp({
      ...baseConfig,
      workflows: [wf],
      platforms: [routeExt],
    });

    const envelope = {
      id: "e1",
      source: "github",
      type: "pr.opened",
      repo: "acme/widgets",
      sender: "alice",
      senderIsBot: false,
      body: "",
      raw: {},
      reply: async () => {},
      timestamp: new Date(),
    } as unknown as EventEnvelope;

    await preset.dispatch(envelope);
    // start() is fire-and-forget; let the microtask flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ input: { repo: "acme/widgets" } }]);
  });

  it("no-ops when no route matches", async () => {
    const preset = await createMacApp({ ...baseConfig });
    const envelope = {
      id: "e2",
      source: "slack",
      type: "message",
      sender: "bob",
      senderIsBot: false,
      body: "hi",
      raw: {},
      reply: async () => {},
      timestamp: new Date(),
    } as unknown as EventEnvelope;
    await expect(preset.dispatch(envelope)).resolves.toBeUndefined();
  });
});

describe("createMacApp — runtime aggregation", () => {
  it("aggregates start hooks in order and stop hooks in reverse", async () => {
    const order: string[] = [];
    const mk = (name: string): MacExtension => ({
      name,
      init: () => ({
        runtime: {
          start: async () => {
            order.push(`start:${name}`);
          },
          stop: async () => {
            order.push(`stop:${name}`);
          },
        },
      }),
    });
    const preset = await createMacApp({
      ...baseConfig,
      platforms: [mk("a"), mk("b")],
    });
    expect(preset.runtime).toBeDefined();
    await preset.runtime!.start();
    await preset.runtime!.stop();
    expect(order).toEqual(["start:a", "start:b", "stop:b", "stop:a"]);
  });

  it("returns no runtime when no extension provides hooks", async () => {
    const preset = await createMacApp({ ...baseConfig });
    expect(preset.runtime).toBeUndefined();
  });
});

describe("createMacApp — live agent proxy registry", () => {
  it("exposes registered agents by typed property and byId, live", async () => {
    let propAgent: Agent | undefined;
    let idAgent: Agent | undefined;
    const reviewer = defineAgent({
      id: "reviewer",
      description: "reviewer",
      create: () => fakeAgent(),
    });
    const wf = defineWorkflow({
      id: "uses-reviewer",
      description: "uses-reviewer",
      requiredAgents: ["reviewer"],
      create: ({ capabilities }) => {
        const reg = capabilities.require(
          capabilityKey<Record<string, Agent> & { byId(id: string): Agent }>(
            "agents",
          ),
        );
        // Typed property access (agents.reviewer) AND byId both resolve live.
        propAgent = (reg as unknown as Record<string, Agent>).reviewer;
        idAgent = reg.byId("reviewer");
        return fakeWorkflow([]);
      },
    });
    const preset = await createMacApp({
      ...baseConfig,
      agents: [reviewer],
      workflows: [wf],
    });
    expect(propAgent).toBe(preset.agents.reviewer);
    expect(idAgent).toBe(preset.agents.reviewer);
  });
});

describe("createMacApp — optional capabilities", () => {
  it("orders an optional consumer after its provider when present", async () => {
    const order: string[] = [];
    const seen: { value?: string } = {};
    const provider = providerExt("foo-provider", fooCap, order);
    const optionalConsumer: MacExtension = {
      name: "opt-consumer",
      optional: [fooCap],
      init(ctx: MacExtensionContext): MacExtensionResult {
        order.push("opt-consumer");
        seen.value = ctx.capabilities.optional(fooCap)?.value;
        return {};
      },
    };
    // Listed consumer-first to prove ordering is by the graph, not input order.
    await createMacApp({ ...baseConfig, platforms: [optionalConsumer, provider] });
    expect(order).toEqual(["foo-provider", "opt-consumer"]);
    expect(seen.value).toBe("foo-provider");
  });

  it("does NOT fail preflight when an optional capability has no provider", async () => {
    const seen: { value?: string } = { value: "sentinel" };
    const optionalConsumer: MacExtension = {
      name: "opt-consumer",
      optional: [fooCap],
      init(ctx: MacExtensionContext): MacExtensionResult {
        seen.value = ctx.capabilities.optional(fooCap)?.value;
        return {};
      },
    };
    // No provider for fooCap — a `requires` would throw here; `optional` must not.
    await expect(
      createMacApp({ ...baseConfig, platforms: [optionalConsumer] }),
    ).resolves.toBeDefined();
    expect(seen.value).toBeUndefined();
  });
});
