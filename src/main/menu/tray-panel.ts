import { randomUUID } from "node:crypto";
import type { DbusClient, DbusSubscription } from "@open-orpheus/dbus";
import { DesktopEnvironment, getDesktopEnvironment } from "@open-orpheus/window";

import { registerShutdownTask } from "../lifecycle";
import { toError } from "../../util";
import { TRAY_PANEL_DBUS } from "./tray-protocol";

const REQUEST_LIFETIME_MS = 2_000;
const PREPARE_TIMEOUT_MS = 600;
const PLACE_TIMEOUT_MS = 1500;

let request: { sender: number; expires: number; sequence: number } | undefined;
let sequence = 0;
let clientPromise: Promise<DbusClient> | undefined;
let connectedClient: DbusClient | undefined;
let quitting = false;
let dismissalSubscription: DbusSubscription | undefined;
const dismissals = new Map<string, () => void>();

export interface TrayPanel {
  title: string;
  place: () => Promise<void>;
  cancel: () => void;
  onDismiss: (callback: () => void) => () => void;
}

/** Only the next tray-menu request from this renderer may use the Shell bridge. */
export function noteTrayMenuRequest(sender: number) {
  if (process.platform !== "linux" || getDesktopEnvironment() !== DesktopEnvironment.Wayland)
    return;
  if (quitting) return;
  request = { sender, expires: Date.now() + REQUEST_LIFETIME_MS, sequence: ++sequence };
}

async function call(method: string, title: string) {
  if (quitting) throw new Error("Application is quitting");
  if (!clientPromise) {
    const connection = import("@open-orpheus/dbus")
      .then(async ({ DbusClient }) => {
        const client = new DbusClient("session");
        connectedClient = client;
        try {
          if (quitting) return client;
          const subscription = await client.subscribe(
            {
              sender: TRAY_PANEL_DBUS.destination,
              path: TRAY_PANEL_DBUS.path,
              interfaceName: TRAY_PANEL_DBUS.interfaceName,
              member: "PanelDismissRequested",
            },
            (err, signal): undefined => {
              if (err || quitting || typeof signal.body[0] !== "string") return undefined;
              try {
                dismissals.get(signal.body[0])?.();
              } catch (error) {
                LOGGER.warn({ err: toError(error) }, "Tray-panel dismissal failed");
              }
              return undefined;
            }
          );
          if (quitting) subscription.unsubscribe();
          else dismissalSubscription = subscription;
          return client;
        } catch (err) {
          try {
            await client.disconnect();
          } finally {
            if (connectedClient === client) connectedClient = undefined;
          }
          throw err;
        }
      })
      .catch((err) => {
        if (clientPromise === connection) clientPromise = undefined;
        throw err;
      });
    clientPromise = connection;
  }
  const client = await clientPromise;
  if (quitting) throw new Error("Application is quitting");
  return client.call({
    ...TRAY_PANEL_DBUS,
    method,
    signature: "s",
    body: [title],
  });
}

/** Undefined uses overlay; null discards a superseded request without showing it. */
export async function takeTrayPanel(sender: number): Promise<TrayPanel | null | undefined> {
  const pending = request;
  if (!pending || pending.sender !== sender) return;
  request = undefined;
  if (pending.expires < Date.now() || quitting) return;
  const title = `Open Orpheus Tray Panel ${randomUUID()}`;
  const cancel = () => {
    dismissals.delete(title);
    // Cleanup must not reconnect a failed initialization merely to cancel a
    // reservation that could never have reached the provider.
    if (clientPromise) void call("CancelPanel", title).catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const preparing = call("PreparePanel", title).then((reply) => {
      if (expired) cancel();
      return reply.body[0] === true;
    });
    const ready = await Promise.race([
      preparing,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve(false);
        }, PREPARE_TIMEOUT_MS);
      }),
    ]);
    if (!ready || quitting || pending.sequence !== sequence) {
      cancel();
      return quitting || pending.sequence !== sequence ? null : undefined;
    }
    return {
      title,
      cancel,
      onDismiss: (callback) => {
        if (!quitting) dismissals.set(title, callback);
        return () => {
          if (dismissals.get(title) === callback) dismissals.delete(title);
        };
      },
      place: async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const reply = await Promise.race([
            call("PlacePanel", title),
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error("Tray-panel placement timed out")),
                PLACE_TIMEOUT_MS
              );
            }),
          ]);
          if (reply.body[0] !== true)
            throw new Error("Desktop adapter could not position the tray panel");
        } catch (err) {
          cancel();
          throw err;
        } finally {
          clearTimeout(deadline);
        }
      },
    };
  } catch (err) {
    LOGGER.debug({ err: toError(err) }, "Optional tray-panel adapter unavailable");
    cancel();
    return quitting || pending.sequence !== sequence ? null : undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

registerShutdownTask({
  name: "tray-panel-adapter",
  run: async () => {
    quitting = true;
    dismissalSubscription?.unsubscribe();
    dismissalSubscription = undefined;
    dismissals.clear();
    request = undefined;
    const connection = clientPromise;
    clientPromise = undefined;
    const closingClient = connectedClient;
    connectedClient = undefined;
    try {
      await closingClient?.disconnect();
    } finally {
      try {
        const client = await connection?.catch(() => undefined);
        if (client && client !== closingClient) await client.disconnect();
      } finally {
        connectedClient = undefined;
      }
    }
  },
});
