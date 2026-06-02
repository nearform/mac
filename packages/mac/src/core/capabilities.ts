/**
 * Typed capability keys + registry.
 *
 * Platform extensions (github/slack) publish configured capabilities under a
 * typed key; agent/workflow extensions consume them by the same key. The key
 * is the single source of truth — it carries the human metadata for
 * operator-facing preflight errors AND the phantom `T` for type-safe retrieval,
 * so there is no parallel string manifest to drift out of sync.
 *
 * Added in MAC refactor Phase 2 (consumed by the host in Phase 6).
 */

export interface MacCapabilityKey<T> {
  /** Stable, enumerable, printable identifier, e.g. "github". */
  id: string;
  /** Human-facing label used in preflight error messages, e.g. "GitHub platform". */
  description?: string;
  /** Type-only phantom field; no runtime value. */
  readonly type?: T;
}

export function capabilityKey<T>(
  id: string,
  description?: string,
): MacCapabilityKey<T> {
  return { id, description } as MacCapabilityKey<T>;
}

export interface MacCapabilityRegistry {
  /** Publish a configured capability value under a typed key. */
  provide<T>(key: MacCapabilityKey<T>, value: T): void;
  /** Preflight: is a provider registered for this key? */
  has(key: MacCapabilityKey<unknown>): boolean;
  /** Non-throwing retrieval. */
  optional<T>(key: MacCapabilityKey<T>): T | undefined;
  /** Type-safe retrieval; throws a clear operator-facing error if absent. */
  require<T>(key: MacCapabilityKey<T>, message?: string): T;
}

/**
 * A simple Map-backed registry keyed by `key.id`. The host creates one per app
 * and passes it to each extension's `init` (see `MacExtensionContext`).
 */
export function createCapabilityRegistry(): MacCapabilityRegistry {
  const store = new Map<string, unknown>();
  return {
    provide(key, value) {
      store.set(key.id, value);
    },
    has(key) {
      return store.has(key.id);
    },
    optional<T>(key: MacCapabilityKey<T>): T | undefined {
      return store.get(key.id) as T | undefined;
    },
    require<T>(key: MacCapabilityKey<T>, message?: string): T {
      if (!store.has(key.id)) {
        const label = key.description ? `${key.id} (${key.description})` : key.id;
        throw new Error(
          message ??
            `no provider for capability "${label}" — is the extension that provides it installed?`,
        );
      }
      return store.get(key.id) as T;
    },
  };
}

/**
 * The grouped shape a platform capability value takes. Values are grouped by
 * how they are used rather than flattened into one bag:
 *  - `tools`: Mastra tools for agents during a session.
 *  - `functions`: deterministic functions for workflow steps.
 *  - `servers`: runtime/route factories for manual composition.
 *  - `metadata`: small descriptive values for routing/labels/auth/observability.
 */
export interface PlatformCapabilities<
  TTools = Record<string, never>,
  TFunctions = Record<string, never>,
  TServers = Record<string, never>,
  TMetadata = Record<string, never>,
> {
  tools?: TTools;
  functions?: TFunctions;
  servers?: TServers;
  metadata?: TMetadata;
}
