import type { DbusClient, DbusSubscription } from "@open-orpheus/dbus";
import { DesktopEnvironment, getDesktopEnvironment } from "@open-orpheus/window";

import { registerShutdownTask } from "../lifecycle";
import { toError } from "../../util";
import { TRAY_PANEL_DBUS } from "./tray-protocol";

const activations = new Set<() => Promise<void>>();

registerShutdownTask({
  name: "tray-activation",
  run: async () => {
    const results = await Promise.allSettled([...activations].map((close) => close()));
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Failed to close tray activations");
  },
});

/** A scoped opt-in; other desktops and older providers keep the existing tray behavior. */
export function registerTrayActivation(showMusicPanel: () => void) {
  if (process.platform !== "linux" || getDesktopEnvironment() !== DesktopEnvironment.Wayland)
    return () => {};
  let closing = false;
  let ready = false;
  let generation = 0;
  let client: DbusClient | undefined;
  const subscriptions: DbusSubscription[] = [];
  const register = async () => {
    const current = ++generation;
    try {
      const reply = await client!.call({
        ...TRAY_PANEL_DBUS,
        method: "RegisterTray",
      });
      if (!closing && current === generation) ready = reply.body[0] === true;
    } catch (err) {
      if (!closing && current === generation) {
        ready = false;
        LOGGER.debug({ err: toError(err) }, "Optional tray activation adapter unavailable");
      }
    }
  };
  const connection = import("@open-orpheus/dbus")
    .then(async ({ DbusClient }) => {
      if (closing) return;
      client = new DbusClient("session");
      subscriptions.push(
        await client.subscribe(
          {
            sender: TRAY_PANEL_DBUS.destination,
            path: TRAY_PANEL_DBUS.path,
            interfaceName: TRAY_PANEL_DBUS.interfaceName,
            member: "MusicPanelRequested",
          },
          (err): undefined => {
            if (!err && ready && !closing) showMusicPanel();
            return undefined;
          }
        )
      );
      if (closing) return;
      subscriptions.push(
        await client.subscribe(
          {
            sender: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            interfaceName: "org.freedesktop.DBus",
            member: "NameOwnerChanged",
          },
          async (err, signal): Promise<undefined> => {
            if (err || closing || signal.body[0] !== TRAY_PANEL_DBUS.destination) return undefined;
            ++generation;
            ready = false;
            if (signal.body[2]) await register();
            return undefined;
          }
        )
      );
      if (!closing) await register();
    })
    .catch(async (err) => {
      if (!closing) {
        ready = false;
        LOGGER.debug({ err: toError(err) }, "Optional tray activation adapter unavailable");
      }
      for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
      const failedClient = client;
      client = undefined;
      await failedClient?.disconnect().catch((error) => {
        LOGGER.warn({ err: toError(error) }, "Failed to close unavailable tray activation adapter");
      });
    });
  let cleanup: Promise<void> | undefined;
  const close = () => {
    if (cleanup) return cleanup;
    closing = true;
    ++generation;
    cleanup = (async () => {
      const closingClient = client;
      client = undefined;
      try {
        for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
        // Disconnect before awaiting initialization to release the owner's lease
        // and interrupt outstanding registration or subscription calls.
        await closingClient?.disconnect();
      } finally {
        try {
          await connection;
        } finally {
          for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
          activations.delete(close);
        }
      }
    })();
    return cleanup;
  };
  activations.add(close);
  return () => {
    void close().catch((err) =>
      LOGGER.warn({ err: toError(err) }, "Failed to close tray activation adapter")
    );
  };
}
