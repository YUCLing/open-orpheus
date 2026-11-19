import type { PluginDesiredState } from "@shared/contracts/plugin-manager-api";
import { PluginKind } from "@shared/contracts/plugin-manager-api";
import { toError } from "@shared/util";

import { kv } from "../settings";

const KEY = "plugins.enabled";

export interface PluginStateStore {
  /** Effective desired state for a plugin, including built-in defaults. */
  desired(id: string, kind: PluginKind): PluginDesiredState;
  isEnabled(id: string, kind: PluginKind): boolean;
  /** Commit an explicit intent change and return the committed revision. */
  setEnabled(id: string, kind: PluginKind, enabled: boolean): Promise<PluginDesiredState>;
}

/**
 * Persisted desired state.
 *
 * Every plugin defaults to disabled; a built-in may opt in through its own
 * metadata. Explicit changes are stored with a monotonically increasing
 * revision so stale realm notifications can be discarded.
 */
export class PluginState implements PluginStateStore {
  private overrides = new Map<string, PluginDesiredState>();
  private defaults = new Map<string, boolean>();
  private pendingWrite: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const stored = await kv.get(KEY);
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
      for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
        if (value === null || typeof value !== "object") continue;
        const { enabled, revision } = value as {
          enabled?: unknown;
          revision?: unknown;
        };
        if (typeof enabled !== "boolean" || typeof revision !== "number") continue;
        this.overrides.set(id, { enabled, revision });
      }
    } catch (error) {
      LOGGER.error({ err: toError(error) }, "Failed to load plugin desired state");
    }
  }

  /** Register the metadata default for a built-in plugin. */
  setDefault(id: string, enabled: boolean): void {
    this.defaults.set(id, enabled);
  }

  desired(id: string, kind: PluginKind): PluginDesiredState {
    const override = this.overrides.get(id);
    if (override) return { ...override };
    return { enabled: kind === PluginKind.Builtin && this.defaults.get(id) === true, revision: 0 };
  }

  isEnabled(id: string, kind: PluginKind): boolean {
    return this.desired(id, kind).enabled;
  }

  async setEnabled(
    id: string,
    kind: PluginKind,
    enabled: boolean
  ): Promise<PluginDesiredState> {
    // Serialize the whole read-merge-write, not just per plugin: two toggles
    // for different plugins must not save from the same stale snapshot.
    const operation = this.pendingWrite.then(async () => {
      const current = this.desired(id, kind);
      if (current.enabled === enabled) return current;

      const next: PluginDesiredState = { enabled, revision: current.revision + 1 };
      const snapshot = Object.fromEntries(this.overrides);
      snapshot[id] = next;
      try {
        await kv.set(KEY, snapshot);
      } catch (error) {
        LOGGER.error({ id, err: toError(error) }, "Failed to persist plugin desired state");
        throw error;
      }
      this.overrides.set(id, next);
      return next;
    });
    this.pendingWrite = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }
}
