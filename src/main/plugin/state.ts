import { PluginKind } from "@shared/contracts/plugin-manager-api";
import { toError } from "@shared/util";

import { kv } from "../settings";

const KEY = "plugins.enabled";

export interface PluginStateStore {
  isEnabled(id: string, kind: PluginKind): boolean;
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

/**
 * Persisted enable overrides.
 *
 * Every plugin defaults to disabled; a built-in may opt in through its own
 * metadata. Only explicit toggles are stored.
 */
export class PluginState implements PluginStateStore {
  private overrides: Record<string, boolean> = {};
  private defaults = new Map<string, boolean>();
  private pendingWrite: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const stored = await kv.get(KEY);
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        this.overrides = { ...(stored as Record<string, boolean>) };
      }
    } catch (error) {
      LOGGER.error({ err: toError(error) }, "Failed to load plugin enable state");
    }
  }

  /** Register the metadata default for a built-in plugin. */
  setDefault(id: string, enabled: boolean): void {
    this.defaults.set(id, enabled);
  }

  isEnabled(id: string, kind: PluginKind): boolean {
    const override = this.overrides[id];
    if (typeof override === "boolean") return override;
    return kind === PluginKind.Builtin && this.defaults.get(id) === true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    // Serialize the whole read-merge-write, not just per plugin: two toggles
    // for different plugins must not save from the same stale snapshot.
    const operation = this.pendingWrite.then(async () => {
      const next = { ...this.overrides, [id]: enabled };
      try {
        await kv.set(KEY, next);
      } catch (error) {
        LOGGER.error({ id, err: toError(error) }, "Failed to persist plugin enable state");
        throw error;
      }
      this.overrides = next;
    });
    this.pendingWrite = operation.catch(() => {});
    return operation;
  }
}
