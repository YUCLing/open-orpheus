import type { DbusClient, DbusSubscription } from "@open-orpheus/dbus";
import { DesktopEnvironment, getDesktopEnvironment } from "@open-orpheus/window";

import { registerShutdownTask } from "../lifecycle";
import { toError } from "../../util";
import { STACKING_DBUS } from "./stacking-protocol";

const STACKING_DISCOVERY_TIMEOUT_MS = 500;

// A timed-out shutdown must still drop the caller-owned bus lease. This also
// lets providers restore their state when a queued request never settles.
function disconnectOnAbort(signal: AbortSignal | undefined, client: DbusClient | null) {
  const disconnect = () => {
    void Promise.resolve()
      .then(() => client?.disconnect())
      .catch((err) => {
        LOGGER.warn({ err: toError(err) }, "Stacking adapter abort disconnect failed");
      });
  };
  if (signal?.aborted) disconnect();
  else signal?.addEventListener("abort", disconnect, { once: true });
  return () => signal?.removeEventListener("abort", disconnect);
}

async function discoveryDeadline<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Stacking adapter discovery timed out")),
          STACKING_DISCOVERY_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StackingTarget {
  id: string;
  title: string;
  pid: number;
}

/** Requested is not an acknowledgement that the compositor found the window. */
export type StackingResult = "applied" | "requested" | "unsupported" | "failed";

export interface WindowStackingAdapter {
  setAbove(target: StackingTarget, enabled: boolean): Promise<StackingResult>;
  release(id: string): Promise<void>;
  discard(): Promise<void>;
}

function isAdapterUnavailable(err: unknown): boolean {
  return /ServiceUnknown|NameHasNoOwner/.test(toError(err).message);
}

/** Desktop extensions may implement this bus API without changing Electron. */
class DBusStackingAdapter implements WindowStackingAdapter {
  private client: DbusClient | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  // Live protocol requests for reconnect; ManagedWindow owns the window and
  // remains the source of the desired always-on-top state.
  private targets = new Map<string, { target: StackingTarget; enabled: boolean }>();
  private subscription: DbusSubscription | null = null;
  private closing = false;

  async activate(): Promise<void> {
    const client = await this.getClient();
    const subscription = await client.subscribe(
      {
        sender: "org.freedesktop.DBus",
        interfaceName: "org.freedesktop.DBus",
        member: "NameOwnerChanged",
        path: "/org/freedesktop/DBus",
      },
      async (err, signal): Promise<undefined> => {
        if (err || this.closing || signal.body[0] !== STACKING_DBUS.destination || !signal.body[2])
          return undefined;
        await this.enqueue(async () => {
          if (this.closing) return;
          for (const { target, enabled } of this.targets.values())
            await this.apply(target, enabled);
        });
        return undefined;
      }
    );
    if (this.closing) {
      subscription.unsubscribe();
      throw new Error("Stacking adapter closed during activation");
    }
    this.subscription = subscription;
    registerShutdownTask({ name: "desktop-stacking-adapter", run: (signal) => this.close(signal) });
  }

  async hasProvider(): Promise<boolean> {
    const client = await this.getClient();
    const owner = await client.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interfaceName: "org.freedesktop.DBus",
      method: "NameHasOwner",
      signature: "s",
      body: [STACKING_DBUS.destination],
    });
    return !this.closing && owner.body[0] === true;
  }

  async discard(): Promise<void> {
    this.closing = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    const client = this.client;
    this.client = null;
    this.targets.clear();
    await client?.disconnect();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  private async getClient(): Promise<DbusClient> {
    if (this.closing) throw new Error("Stacking adapter is closing");
    if (!this.client) {
      const { DbusClient } = await import("@open-orpheus/dbus");
      if (this.closing) throw new Error("Stacking adapter closed during connection setup");
      this.client = new DbusClient("session");
    }
    return this.client;
  }

  private async apply(target: StackingTarget, enabled: boolean): Promise<StackingResult> {
    try {
      const client = await this.getClient();
      const reply = await client.call({
        ...STACKING_DBUS,
        method: "SetAbove",
        signature: "ssub",
        body: [target.id, target.title, target.pid, enabled],
      });
      const status = reply.body[0];
      if (status !== "applied" && status !== "requested")
        throw new Error("Unexpected stacking adapter reply");
      LOGGER.info(
        { windowId: target.id, enabled, status },
        "Requested window stacking through desktop extension"
      );
      return status;
    } catch (err) {
      LOGGER.warn(
        { err: toError(err), windowId: target.id },
        "Desktop stacking extension request failed"
      );
      return isAdapterUnavailable(err) ? "unsupported" : "failed";
    }
  }

  setAbove(target: StackingTarget, enabled: boolean): Promise<StackingResult> {
    if (this.closing) return Promise.resolve("failed");
    const request = { target, enabled };
    this.targets.set(target.id, request);
    return this.enqueue(async () => {
      if (this.closing || this.targets.get(target.id) !== request) return "failed";
      return this.apply(target, enabled);
    });
  }

  private async releaseTarget(id: string): Promise<void> {
    try {
      await this.client?.call({
        ...STACKING_DBUS,
        method: "Release",
        signature: "s",
        body: [id],
      });
    } catch (err) {
      if (!isAdapterUnavailable(err)) throw err;
    }
  }

  release(id: string): Promise<void> {
    // Retire replay ownership immediately, even while an earlier call is pending.
    if (!this.targets.delete(id)) return Promise.resolve();
    return this.enqueue(() => this.releaseTarget(id));
  }

  private async close(signal?: AbortSignal): Promise<void> {
    this.closing = true;
    this.subscription?.unsubscribe();
    this.subscription = null;
    const targets = [...this.targets.keys()];
    this.targets.clear();
    const detach = disconnectOnAbort(signal, this.client);
    try {
      await this.enqueue(async () => {
        try {
          const results = await Promise.allSettled(targets.map((id) => this.releaseTarget(id)));
          const errors = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (errors.length) throw new AggregateError(errors, "Failed to release stacking targets");
        } finally {
          const client = this.client;
          this.client = null;
          await client?.disconnect();
        }
      });
    } finally {
      detach();
    }
  }
}

let adapter: WindowStackingAdapter | null = null;
let initialization: Promise<void> | null = null;

/** Probe an extension on ANY Wayland desktop before choosing a window role. */
export function initializeWindowStackingAdapter(): Promise<void> {
  if (process.platform !== "linux" || getDesktopEnvironment() !== DesktopEnvironment.Wayland)
    return Promise.resolve();
  return (initialization ??= discoverWindowStackingAdapter());
}

async function discoverWindowStackingAdapter(): Promise<void> {
  const external = new DBusStackingAdapter();
  try {
    if (await discoveryDeadline(external.hasProvider())) {
      await discoveryDeadline(external.activate());
      adapter = external;
      LOGGER.info("Using the desktop-independent window stacking adapter");
      return;
    }
  } catch (err) {
    LOGGER.debug({ err: toError(err) }, "Desktop stacking adapter unavailable");
  }
  await external.discard().catch((err) => {
    LOGGER.warn({ err: toError(err) }, "Failed to close unused stacking adapter connection");
  });
}

export function getWindowStackingAdapter(): WindowStackingAdapter | null {
  return adapter;
}

/** Retire a failed backend before recreating the lyrics with the existing policy. */
export function disableWindowStackingAdapter(expected: WindowStackingAdapter): boolean {
  if (adapter !== expected) return false;
  adapter = null;
  void expected.discard().catch((err) => {
    LOGGER.warn({ err: toError(err) }, "Failed to discard retired stacking adapter");
  });
  return true;
}
