import type { Agent } from "@mastra/core/agent";
import type { Workflow } from "@mastra/core/workflows";
import type { ApiRoute } from "@mastra/core/server";
import type { MCPServerBase } from "@mastra/core/mcp";

import type {
  DispatchFn,
  EventEnvelope,
  MacCapabilityKey,
  MacCapabilityRegistry,
  MacExtension,
  MacExtensionResult,
  MacAgentDefinition,
  MacWorkflowDefinition,
  MacRouteContribution,
  MacRouteTarget,
  MacClassifier,
  MacClassification,
  MacClassifierIntent,
  MacGuardConfig,
  MacRoutingConfig,
  ReplyGateLookup,
  RouteContext,
  WorkspaceFactory,
  ApprovalLinkBuilder,
  InteractiveDispatch,
} from "../core/index.js";
import {
  agentRegistryCapability,
  applyInjectionFlag,
  capabilityKey,
  createAgentRegistry,
  createCapabilityRegistry,
} from "../core/index.js";
import { buildMcpSurface } from "./mcp.js";
import type { MacMcpConfig, MacMcpSurface } from "./mcp.js";
import { createLlmClassifier } from "./classifier/index.js";

/** Author associations allowed to command the bot when no override is configured. */
const DEFAULT_MAINTAINER_ROLES = ["OWNER", "MEMBER", "COLLABORATOR"];

/** Capability key (string-id only) for reading github metadata without a package dep. */
const githubMetadataKey = capabilityKey<{ metadata?: { managedRepos?: string[] } }>("github");

/**
 * `createMacApp` — the MAC host. Normalizes platforms/agents/workflows into one
 * ordered init/merge path, owns the single live agent registry, runs inits in
 * topological order, assembles the contribution router, and returns plain
 * registries that spread into a `Mastra` instance.
 *
 * Lives in the package ROOT (not `/core`) because it pulls preset weight. See
 * the refactor doc, "Extension Model" / "Capability Wiring" / "Preset Output".
 */
export interface MacAppConfig {
  model: string;
  workspaceFactory?: WorkspaceFactory;
  /** Builds signed approval/reject links for human-in-the-loop gates (app-provided). */
  approvalLinks?: ApprovalLinkBuilder;
  platforms?: MacExtension[];
  agents?: Array<MacExtension | MacAgentDefinition>;
  workflows?: Array<MacExtension | MacWorkflowDefinition>;
  routing?: MacRoutingConfig;
  prompts?: { overrideDir?: string };
  /** Opt-in MCP surface selection/gating. Omitted → MCP off (embedded path unaffected). */
  mcp?: MacMcpConfig;
  /**
   * Opt-in interactive/conversational dispatcher. When set, `agent`-target
   * routes are delegated here (e.g. to a Mastra `Harness`) instead of the
   * built-in bare `agent.generate(...)` path. Omitted → unchanged behaviour.
   */
  interactive?: InteractiveDispatch;
  /**
   * Optional structured logger for dispatch diagnostics (route → agent/workflow).
   * Pass the app's Mastra logger so dispatch lines share the same format as
   * workflow/agent logs. Omitted → falls back to `console`.
   */
  logger?: MacLogger;
}

/** Minimal structured-logger surface the dispatch uses (matches IMastraLogger). */
export interface MacLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface MacPreset {
  agents: Record<string, Agent>;
  workflows: Record<string, Workflow>;
  apiRoutes: ApiRoute[];
  mcpServers: Record<string, MCPServerBase>;
  /** The resolved, gated MCP surface manifest (concrete server construction deferred). */
  mcp: MacMcpSurface;
  dispatch: DispatchFn;
  /** Assembled route contributions (for introspection / MCP). */
  routes: MacRouteContribution[];
  /** Assembled classifier intents. */
  classifierIntents: MacClassifierIntent[];
  runtime?: { start(): Promise<void>; stop(): Promise<void> };
}

/** An internal, uniform unit the host orders and runs. */
interface InitUnit {
  name: string;
  provides: MacCapabilityKey<unknown>[];
  requires: MacCapabilityKey<unknown>[];
  /**
   * Preferred-but-not-required capabilities: they create an ordering edge (so a
   * provider, if installed, inits first) but are NOT preflight-validated.
   */
  optional: MacCapabilityKey<unknown>[];
  /** Ids this unit may deliberately replace (from a definition's `overrides`). */
  overrides: Set<string>;
  run(): Promise<MacExtensionResult>;
}

/** Type guard: an entry that carries an `init` function is a `MacExtension`. */
function isExtension(
  entry: MacExtension | MacAgentDefinition | MacWorkflowDefinition,
): entry is MacExtension {
  return typeof (entry as MacExtension).init === "function";
}

export async function createMacApp(config: MacAppConfig): Promise<MacPreset> {
  // 1. Capability registry.
  const capabilities = createCapabilityRegistry();

  // 2. Host-owned live agent registry (the keystone). One mutable record shared
  //    by every consumer; a Proxy exposes BOTH the MacAgentRegistry methods and
  //    typed property access (`agents.reviewer`) and stays live as agents grow.
  const agentMap: Record<string, Agent> = {};
  const baseRegistry = createAgentRegistry(agentMap);
  const REGISTRY_METHODS = new Set(["byId", "find", "ids"]);
  const proxyRegistry = new Proxy(baseRegistry, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !REGISTRY_METHODS.has(prop)) {
        // Live typed property access used by built-in workflows (agents.reviewer).
        if (Object.prototype.hasOwnProperty.call(agentMap, prop)) {
          return agentMap[prop];
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // Provide the one live registry BEFORE any init runs, under the core "agents"
  // key (agentCapabilities shares the same id). The proxy satisfies MacAgents
  // structurally via property access + registry methods.
  capabilities.provide(
    agentRegistryCapability,
    proxyRegistry as unknown as never,
  );

  // Stable dispatch closure created before inits so extensions (webhook/Slack
  // connectors) can capture it. The assembled routes/intents and the resolved
  // classifier/guards/seams are filled in after inits; the closure reads them
  // lazily so it sees the final, assembled values.
  let assembledRoutes: MacRouteContribution[] = [];
  let assembledIntents: MacClassifierIntent[] = [];
  let defaultIntent: MacClassifierIntent | undefined;
  let classifier: MacClassifier | undefined;
  let guardConfig: MacGuardConfig | undefined;
  let replyGateFn: ReplyGateLookup | undefined;
  let isManagedRepoFn: (repo: string | null | undefined) => boolean = () => true;
  let managedReposList: () => string[] = () => [];
  const finalAgents: Record<string, Agent> = agentMap; // same record
  const finalWorkflows: Record<string, Workflow> = {};

  /**
   * The dispatch pipeline (Phase 11): pre-rule guards → deterministic event
   * match → classifier match. Guards short-circuit comment/message events
   * (reply-gate, mention/maintainer, approval/security commands); deterministic
   * routes handle events with `eventTypes` (e.g. PR attention → pr-review); the
   * classifier resolves free-form text (mentioned GitHub comments, Slack
   * messages) to an intent and runs its target.
   */
  const dispatch: DispatchFn = async (envelope: EventEnvelope) => {
    const guarded = await runGuards(envelope);
    if (guarded.kind === "handled") return guarded.result;

    // Deterministic event match — routes discriminated by eventTypes or `when`.
    const sorted = [...assembledRoutes].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    for (const route of sorted) {
      if (route.source && route.source !== envelope.source) continue;
      if (route.eventTypes) {
        if (!route.eventTypes.includes(envelope.type)) continue;
      } else if (!route.when) {
        // A route with neither eventTypes nor when is not a deterministic
        // match (it would swallow everything) — skip it here.
        continue;
      }
      const ctx: RouteContext = { envelope, routeKey: route.id };
      if (route.when && !(await route.when(ctx))) continue;
      return runTarget(route.target, ctx, envelope);
    }

    if (guarded.kind === "classify") return runClassifierPhase(envelope);
    return undefined;
  };

  type GuardOutcome =
    | { kind: "handled"; result: unknown }
    | { kind: "classify" }
    | { kind: "skip" };

  async function runGuards(envelope: EventEnvelope): Promise<GuardOutcome> {
    if (envelope.type === "comment.created") return runCommentGuards(envelope);
    if (envelope.type === "message") {
      const gated = await tryReplyGate(envelope);
      if (gated) return { kind: "handled", result: gated.result };
      return { kind: "classify" };
    }
    return { kind: "skip" };
  }

  async function runCommentGuards(envelope: EventEnvelope): Promise<GuardOutcome> {
    // Reply-gate short-circuit sits ABOVE the mention/maintainer checks: a
    // paused explore run consumes any free-form reply on the thread.
    const gated = await tryReplyGate(envelope);
    if (gated) return { kind: "handled", result: gated.result };

    const g = guardConfig;
    // No mention pattern configured → the host does not act on comments at all
    // (mention-gating is the norm for bots; the app supplies /@mac-nf\b/i).
    if (!g?.mentionPattern) return { kind: "handled", result: undefined };

    if (!g.mentionPattern.test(envelope.body)) {
      return { kind: "handled", result: undefined }; // no mention → ignore
    }

    const roles = g.maintainerRoles ?? DEFAULT_MAINTAINER_ROLES;
    if (!roles.includes(envelope.authorAssociation ?? "")) {
      const ctx: RouteContext = { envelope };
      const msg = resolveMessage(g.nonMaintainerReply, ctx) ?? defaultNonMaintainerReply(envelope);
      return { kind: "handled", result: await envelope.reply(msg) };
    }

    const cmds = mentionCommands(g.mentionPattern);
    if (cmds.approve.test(envelope.body) || cmds.reject.test(envelope.body)) {
      const ctx: RouteContext = { envelope };
      const msg = resolveMessage(g.approvalReply, ctx) ?? DEFAULT_APPROVAL_REPLY;
      return { kind: "handled", result: await envelope.reply(msg) };
    }
    if (cmds.security.test(envelope.body)) {
      const target = findRouteTargetById(`${envelope.source}.security_review`);
      if (target) {
        const ctx: RouteContext = { envelope, routeKey: `${envelope.source}.security_review` };
        return { kind: "handled", result: await runTarget(target, ctx, envelope) };
      }
      // Unwired → fall through to classification.
    }

    return { kind: "classify" };
  }

  /** Reply-gate lookup + dispatch to a registered `<source>.explore_reply` target. */
  async function tryReplyGate(
    envelope: EventEnvelope,
  ): Promise<{ result: unknown } | undefined> {
    if (!replyGateFn) return undefined;
    const triggerId = replyGateTriggerId(envelope);
    if (!triggerId) return undefined;
    const pending = replyGateFn(triggerId);
    if (!pending) return undefined;
    const target = findRouteTargetById(`${envelope.source}.explore_reply`);
    if (!target) return undefined; // no explore-reply target wired → fall through
    const ctx: RouteContext = {
      envelope,
      routeKey: `${envelope.source}.explore_reply`,
      replyGate: { workflowRunId: pending.workflowRunId },
    };
    return { result: await runTarget(target, ctx, envelope) };
  }

  async function runClassifierPhase(envelope: EventEnvelope): Promise<unknown> {
    if (!classifier) return undefined; // classification disabled (no classifier)
    const classification = await classifier.classify(envelope.body, {
      issueTitle: envelope.title,
      isPullRequest: !!envelope.prNumber,
    });
    return dispatchClassified(envelope, classification);
  }

  function dispatchClassified(
    envelope: EventEnvelope,
    classification: MacClassification,
  ): Promise<unknown> {
    const intent = classification.intentId
      ? assembledIntents.find(
          (i) => i.id.toUpperCase() === classification.intentId!.toUpperCase(),
        )
      : undefined;
    if (!intent) return routeDefaultOrReply(envelope, classification);

    // Effective repo/issue: the envelope (a GitHub issue/PR comment) takes
    // precedence; otherwise the classifier-extracted ref (a Slack message).
    const effectiveRepo = envelope.repo ?? classification.repo;
    const effectiveIssue =
      envelope.prNumber ?? envelope.issueNumber ?? classification.issueNumber;
    const req = intent.requires ?? {};

    // Missing repo/issue → fall back to the default intent (e.g. a "build" with
    // no repo becomes a chat reply) rather than nagging.
    if ((req.repo || req.managedRepo) && !effectiveRepo) {
      return routeDefaultOrReply(envelope, classification);
    }
    if (req.issueNumber && effectiveIssue === undefined) {
      return routeDefaultOrReply(envelope, classification);
    }
    // Present-but-unmanaged repo → refuse.
    if (req.managedRepo && effectiveRepo && !isManagedRepoFn(effectiveRepo)) {
      return envelope.reply(unmanagedRepoReply(effectiveRepo));
    }
    if (req.maintainer && !isMaintainer(envelope)) {
      const ctx: RouteContext = { envelope, classification };
      return envelope.reply(
        resolveMessage(guardConfig?.nonMaintainerReply, ctx) ?? defaultNonMaintainerReply(envelope),
      );
    }

    const ctx: RouteContext = {
      envelope,
      classification,
      routeKey: `${envelope.source}.${intent.id}`,
    };
    return runTarget(intent.target, ctx, envelope);
  }

  function routeDefaultOrReply(
    envelope: EventEnvelope,
    classification: MacClassification,
  ): Promise<unknown> {
    if (defaultIntent) {
      const ctx: RouteContext = {
        envelope,
        classification,
        routeKey: `${envelope.source}.${defaultIntent.id}`,
      };
      return runTarget(defaultIntent.target, ctx, envelope);
    }
    const msg = resolveMessage(guardConfig?.unroutableReply, { envelope, classification });
    if (msg) return envelope.reply(msg);
    return Promise.resolve(undefined);
  }

  async function runTarget(
    target: MacRouteTarget,
    ctx: RouteContext,
    envelope: EventEnvelope,
  ): Promise<unknown> {
    // Dispatch diagnostics go through the app's logger (same format as
    // workflow/agent logs) when provided; otherwise console.
    const log = config.logger ?? console;
    switch (target.type) {
      case "workflow": {
        const wf = finalWorkflows[target.id];
        if (!wf) return undefined; // preflighted at startup; defensive only
        const input = target.input?.(ctx) ?? {};
        log.info(
          `[dispatch] workflow "${target.id}" ← ${envelope.sender || "anonymous"}@${envelope.source}` +
            (envelope.repo ? ` ${envelope.repo}` : "") +
            (envelope.issueNumber ? `#${envelope.issueNumber}` : ""),
        );
        const run = await wf.createRun();
        // Fire-and-forget: the webhook/Slack handler must respond fast, and the
        // run may suspend at an approval gate.
        void Promise.resolve(run.start({ inputData: input })).catch((err: unknown) => {
          log.error(`[dispatch] workflow "${target.id}" failed:`, err);
        });
        return undefined;
      }
      case "agent": {
        const agent = finalAgents[target.id];
        if (!agent) return undefined; // preflighted at startup; defensive only
        const raw = envelope.raw as Record<string, unknown> | undefined;
        const input = target.input
          ? target.input(ctx)
          : applyInjectionFlag(envelope.body, ctx.classification);
        // Memory keyed per thread: a stable per-thread session key (set by the
        // connector) or the envelope id, resource = the sender.
        const thread = (typeof raw?.sessionId === "string" && raw.sessionId) || envelope.id;
        const resource = envelope.sender || "anonymous";
        // One-line preview of the inbound message so it's visible in the log
        // stream that a chat actually happened (the happy path was silent). The
        // body is whitespace-collapsed and capped; a `…` + total length is
        // appended only when it was actually truncated.
        const flat = String(input ?? "").replace(/\s+/g, " ").trim();
        const truncated = flat.length > 120;
        const body = truncated ? `${flat.slice(0, 120)}…` : flat;
        const suffix = truncated ? ` (${flat.length} chars)` : "";
        const lane = config.interactive ? "interactive" : "generate";
        log.info(
          `[dispatch] agent "${target.id}" (${lane}) ← ${resource}@${envelope.source} thread=${thread}: "${body}"${suffix}`,
        );
        try {
          // Interactive lane: delegate to the app-provided dispatcher (e.g. a
          // Harness) when configured; otherwise the built-in bare generate path.
          if (config.interactive) {
            await config.interactive.handle({
              agentId: target.id,
              message: typeof input === "string" ? input : String(input ?? ""),
              threadId: thread,
              resource,
              reply: (m: string) => envelope.reply(m),
            });
            return undefined;
          }
          const res = await (agent as { generate: (i: unknown, o?: unknown) => Promise<{ text?: string }> })
            .generate(input, { memory: { thread, resource } });
          const text = (res?.text ?? "").trim();
          log.info(
            `[dispatch] agent "${target.id}" → ${resource}: replied ${text.length} chars`,
          );
          await envelope.reply(text || "…").catch(() => {});
        } catch (err) {
          log.error(`[dispatch] agent "${target.id}" generate failed:`, err);
          await envelope.reply("⚠️ Something went wrong handling that — try again?").catch(() => {});
        }
        return undefined;
      }
      case "reply": {
        const message =
          typeof target.message === "function" ? target.message(ctx) : target.message;
        return envelope.reply(message);
      }
      case "ignore":
        return undefined;
    }
  }

  // ── Pipeline helpers ──────────────────────────────────────────────────────

  function findRouteTargetById(id: string): MacRouteTarget | undefined {
    return assembledRoutes.find((r) => r.id === id)?.target;
  }

  function isMaintainer(envelope: EventEnvelope): boolean {
    const roles = guardConfig?.maintainerRoles ?? DEFAULT_MAINTAINER_ROLES;
    return roles.includes(envelope.authorAssociation ?? "");
  }

  function unmanagedRepoReply(repo: string): string {
    const list = managedReposList();
    const managed = list.length
      ? `\nManaged repos: ${list.map((r) => `\`${r}\``).join(", ")}.`
      : "";
    return `❌ I'm not configured to work on \`${repo}\`.${managed}`;
  }

  function replyGateTriggerId(envelope: EventEnvelope): string | undefined {
    if (envelope.source === "github") {
      return envelope.issueNumber ? `${envelope.repo}#${envelope.issueNumber}` : undefined;
    }
    if (envelope.source === "slack") {
      const raw = envelope.raw as Record<string, unknown> | undefined;
      const channelId = raw?.channelId as string | undefined;
      const threadId = raw?.threadId as string | undefined;
      const teamId =
        (raw?.team as string | undefined) || (raw?.team_id as string | undefined) || "slack";
      return channelId && threadId ? `slack:${teamId}:${channelId}:${threadId}` : undefined;
    }
    return undefined;
  }

  // 3. Normalize the three groups into ordered init units.
  const units: InitUnit[] = [];

  // The shared extension context (dispatch + capabilities are stable).
  const extContext = {
    model: config.model,
    workspaceFactory: config.workspaceFactory,
    dispatch,
    capabilities,
  };

  for (const ext of config.platforms ?? []) {
    if (!isExtension(ext)) {
      throw new Error(
        `platforms[] entry must be a MacExtension with an init() function (got: ${describe(ext)})`,
      );
    }
    units.push(extensionUnit(ext));
  }

  for (const entry of config.agents ?? []) {
    if (isExtension(entry)) {
      units.push(extensionUnit(entry));
    } else {
      units.push(agentDefinitionUnit(entry));
    }
  }

  for (const entry of config.workflows ?? []) {
    if (isExtension(entry)) {
      units.push(extensionUnit(entry));
    } else {
      units.push(workflowDefinitionUnit(entry));
    }
  }

  function extensionUnit(ext: MacExtension): InitUnit {
    return {
      name: ext.name,
      provides: ext.provides ?? [],
      requires: ext.requires ?? [],
      optional: ext.optional ?? [],
      overrides: new Set(),
      run: () => Promise.resolve(ext.init(extContext)),
    };
  }

  function agentDefinitionUnit(def: MacAgentDefinition): InitUnit {
    return {
      name: `agent:${def.id}`,
      provides: [],
      requires: def.requires ?? [],
      optional: def.optional ?? [],
      overrides: def.overrides ? new Set([def.overrides]) : new Set(),
      run: async () => {
        const agent = def.create({
          model: config.model,
          capabilities,
          workspaceFactory: config.workspaceFactory,
          approvalLinks: config.approvalLinks,
        });
        return {
          agents: { [def.id]: agent },
          routes: def.routes,
          classifierIntents: def.classifierIntents,
        };
      },
    };
  }

  function workflowDefinitionUnit(def: MacWorkflowDefinition): InitUnit {
    // A workflow with requiredAgents implicitly requires the agent registry, so
    // it orders after any agent-producing unit.
    const requires = [...(def.requires ?? [])];
    if (def.requiredAgents && def.requiredAgents.length > 0) {
      if (!requires.some((k) => k.id === agentRegistryCapability.id)) {
        requires.push(agentRegistryCapability);
      }
    }
    return {
      name: `workflow:${def.id}`,
      provides: [],
      requires,
      optional: def.optional ?? [],
      overrides: def.overrides ? new Set([def.overrides]) : new Set(),
      run: async () => {
        // Validate required agents are registered before create().
        for (const aid of def.requiredAgents ?? []) {
          if (!Object.prototype.hasOwnProperty.call(agentMap, aid)) {
            throw new Error(
              `workflow "${def.id}" requires agent "${aid}" which is not registered`,
            );
          }
        }
        const wf = def.create({
          model: config.model,
          capabilities,
          workspaceFactory: config.workspaceFactory,
          approvalLinks: config.approvalLinks,
        });
        return {
          workflows: { [def.id]: wf },
          routes: def.routes,
          classifierIntents: def.classifierIntents,
        };
      },
    };
  }

  // 5/6. Topological ordering + cycle detection + preflight required capabilities.
  // The host pre-provided set (currently the agent registry) counts as satisfied.
  const hostProvided = new Set<string>([agentRegistryCapability.id]);

  // Map each capability id to the units that provide it.
  const providersOf = new Map<string, InitUnit[]>();
  for (const unit of units) {
    for (const key of unit.provides) {
      const list = providersOf.get(key.id) ?? [];
      list.push(unit);
      providersOf.set(key.id, list);
    }
  }

  // Preflight: every required key must be provided by a unit OR host-provided.
  for (const unit of units) {
    for (const key of unit.requires) {
      if (hostProvided.has(key.id)) continue;
      if (providersOf.has(key.id)) continue;
      const label = key.description ? `${key.id} (${key.description})` : `${key.id}`;
      throw new Error(
        `"${unit.name}" requires capability "${label}" which no installed extension provides`,
      );
    }
  }

  const ordered = topoSort(units, providersOf);

  // 7. Run inits in topological order, merging results.
  const producedAgentIds = new Set<string>(); // ids produced by a unit
  const producedWorkflowIds = new Set<string>();
  const apiRoutes: ApiRoute[] = [];
  const mcpServers: Record<string, MCPServerBase> = {};
  const extensionRoutes: MacRouteContribution[] = [];
  const extensionIntents: MacClassifierIntent[] = [];
  const startHooks: Array<() => Promise<void>> = [];
  const stopHooks: Array<() => Promise<void>> = [];

  for (const unit of ordered) {
    const result = await unit.run();

    if (result.agents) {
      for (const [id, agent] of Object.entries(result.agents)) {
        guardDuplicate(id, producedAgentIds, unit, "agent");
        producedAgentIds.add(id);
        agentMap[id] = agent;
      }
    }
    if (result.workflows) {
      for (const [id, wf] of Object.entries(result.workflows)) {
        guardDuplicate(id, producedWorkflowIds, unit, "workflow");
        producedWorkflowIds.add(id);
        finalWorkflows[id] = wf;
      }
    }
    if (result.apiRoutes) apiRoutes.push(...result.apiRoutes);
    if (result.mcpServers) Object.assign(mcpServers, result.mcpServers);
    if (result.routes) extensionRoutes.push(...result.routes);
    if (result.classifierIntents) extensionIntents.push(...result.classifierIntents);
    if (result.runtime) {
      startHooks.push(() => result.runtime!.start());
      stopHooks.push(() => result.runtime!.stop());
    }
  }

  // 8. Assemble routes + intents.
  const routes: MacRouteContribution[] = [];
  if (config.routing?.includeDefaults !== false) {
    routes.push(...builtinDefaultRoutes());
  }
  routes.push(...extensionRoutes);
  if (config.routing?.add) routes.push(...config.routing.add);

  // Apply overrideTargets by `<source>.<event-or-intent>` key == route id.
  if (config.routing?.overrideTargets) {
    for (const route of routes) {
      const override = config.routing.overrideTargets[route.id];
      if (override) route.target = override;
    }
  }

  const classifierIntents: MacClassifierIntent[] = [
    ...extensionIntents,
    ...(config.routing?.classifier?.extraIntents ?? []),
  ];
  if (config.routing?.overrideTargets) {
    for (const intent of classifierIntents) {
      const override = config.routing.overrideTargets[intent.id];
      if (override) intent.target = override;
    }
  }

  assembledRoutes = routes;
  assembledIntents = classifierIntents;
  defaultIntent = classifierIntents.find((i) => i.isDefault);

  // Resolve the routing seams (classifier / guards / reply-gate / managed-repo).
  // The classifier defaults to the data-driven LLM classifier assembled from the
  // merged catalogue when none is injected and a model is set.
  guardConfig = config.routing?.guards;
  replyGateFn = config.routing?.replyGate;
  isManagedRepoFn = resolveManagedRepoCheck(config.routing, capabilities);
  managedReposList = resolveManagedReposList(config.routing, capabilities);
  classifier =
    config.routing?.classifier?.classify ??
    (classifierIntents.length > 0
      ? // No `model` passed → the classifier uses a fast/cheap model resolved
        // from env (these classify/screen calls are tiny); the main `config.model`
        // is reserved for the agents/workflows themselves.
        createLlmClassifier({ intents: classifierIntents })
      : undefined);

  // 10. Preflight route targets against the final registries.
  const validateTarget = (target: MacRouteTarget, where: string) => {
    if (target.type === "workflow" && !finalWorkflows[target.id]) {
      throw new Error(
        `${where} references workflow "${target.id}" which is not registered`,
      );
    }
    if (target.type === "agent" && !agentMap[target.id]) {
      throw new Error(
        `${where} references agent "${target.id}" which is not registered`,
      );
    }
  };
  for (const route of routes) validateTarget(route.target, `route "${route.id}"`);
  for (const intent of classifierIntents)
    validateTarget(intent.target, `classifier intent "${intent.id}"`);

  // Combined runtime hooks: start in order, stop in reverse.
  const runtime =
    startHooks.length > 0
      ? {
          async start() {
            for (const hook of startHooks) await hook();
          },
          async stop() {
            for (const hook of [...stopHooks].reverse()) await hook();
          },
        }
      : undefined;

  // 9. Compute the gated MCP surface manifest from the final registries.
  const mcp = buildMcpSurface({
    config: config.mcp,
    workflows: finalWorkflows,
    agents: agentMap,
    hasApprovalLinks: !!config.approvalLinks,
  });

  // 11. Return the preset. Do NOT auto-start runtime.
  return {
    agents: agentMap,
    workflows: finalWorkflows,
    apiRoutes,
    // TODO(MCP): construct a concrete @mastra/mcp MCPServer from this surface
    // once @mastra/mcp is added as a dependency; until then `mcp` is a manifest
    // describing the intended surface and `mcpServers` stays empty.
    mcpServers,
    mcp,
    dispatch,
    routes,
    classifierIntents,
    runtime,
  };
}

/** Minimal built-in default route set. Extensions contribute the real defaults. */
function builtinDefaultRoutes(): MacRouteContribution[] {
  return [];
}

/** The default nudge for a maintainer-only command from a non-maintainer. */
function defaultNonMaintainerReply(envelope: EventEnvelope): string {
  return (
    `Thanks for the report, @${envelope.sender}! ` +
    `I only act on requests from repository maintainers — a maintainer ` +
    `(owner / member / collaborator) needs to mention me to trigger a build.`
  );
}

/** The default reply to an `approve`/`reject` TEXT command (the gate uses links). */
const DEFAULT_APPROVAL_REPLY =
  "Use the ✅ **Approve** / ❌ **Reject** links in the status comment to resolve the gate.";

/** Resolve a static-or-callback message field against the route context. */
function resolveMessage(
  message: string | ((ctx: RouteContext) => string) | undefined,
  ctx: RouteContext,
): string | undefined {
  if (message === undefined) return undefined;
  return typeof message === "function" ? message(ctx) : message;
}

/**
 * Derive the `approve` / `reject` / `security-review` command patterns from the
 * bot mention pattern, so an app configures one mention and gets all three
 * (`@mac-nf approve`, `@mac-nf security-review`, …).
 */
function mentionCommands(mention: RegExp): {
  approve: RegExp;
  reject: RegExp;
  security: RegExp;
} {
  const src = mention.source.replace(/\\b$/, "");
  return {
    approve: new RegExp(`${src}\\s+approve\\b`, "i"),
    reject: new RegExp(`${src}\\s+reject\\b`, "i"),
    security: new RegExp(`${src}\\s+security-review\\b`, "i"),
  };
}

/**
 * The managed-repo check: prefer an injected fn, else read `github` capability
 * metadata (`managedRepos`), else no gating (every repo allowed).
 */
function resolveManagedRepoCheck(
  routing: MacRoutingConfig | undefined,
  capabilities: MacCapabilityRegistry,
): (repo: string | null | undefined) => boolean {
  if (routing?.isManagedRepo) return routing.isManagedRepo;
  const list = capabilities.optional(githubMetadataKey)?.metadata?.managedRepos;
  if (list && list.length > 0) {
    const set = new Set(list);
    return (repo) => !!repo && set.has(repo);
  }
  return () => true;
}

/** The managed-repo allowlist for the refusal message: injected, else github metadata. */
function resolveManagedReposList(
  routing: MacRoutingConfig | undefined,
  capabilities: MacCapabilityRegistry,
): () => string[] {
  if (routing?.managedRepos) return routing.managedRepos;
  const list = capabilities.optional(githubMetadataKey)?.metadata?.managedRepos ?? [];
  return () => list;
}

function describe(entry: unknown): string {
  if (entry && typeof entry === "object" && "name" in entry) {
    return String((entry as { name: unknown }).name);
  }
  return typeof entry;
}

/**
 * Duplicate-id guard. A later unit reusing an existing id throws UNLESS the
 * producing definition declared `overrides` equal to that id.
 */
function guardDuplicate(
  id: string,
  produced: Set<string>,
  unit: InitUnit,
  kind: "agent" | "workflow",
): void {
  if (!produced.has(id)) return;
  if (unit.overrides.has(id)) return;
  throw new Error(
    `duplicate ${kind} id "${id}" — declare \`overrides: "${id}"\` to deliberately replace it`,
  );
}

/** Topological sort by provides/requires capability ids; throws on cycle. */
function topoSort(
  units: InitUnit[],
  providersOf: Map<string, InitUnit[]>,
): InitUnit[] {
  const visited = new Set<InitUnit>();
  const inStack = new Set<InitUnit>();
  const ordered: InitUnit[] = [];

  const visit = (unit: InitUnit, path: InitUnit[]) => {
    if (visited.has(unit)) return;
    if (inStack.has(unit)) {
      const names = [...path, unit].map((u) => u.name).join(" -> ");
      throw new Error(`extension dependency cycle: ${names}`);
    }
    inStack.add(unit);
    // Both required and optional capabilities create an ordering edge so any
    // installed provider inits first; optional differs only in that a MISSING
    // provider is not a preflight error (handled separately, above).
    for (const key of [...unit.requires, ...unit.optional]) {
      // host-provided keys have no in-graph provider edge
      const providers = providersOf.get(key.id) ?? [];
      for (const provider of providers) {
        if (provider === unit) continue;
        visit(provider, [...path, unit]);
      }
    }
    inStack.delete(unit);
    visited.add(unit);
    ordered.push(unit);
  };

  for (const unit of units) visit(unit, []);
  return ordered;
}
