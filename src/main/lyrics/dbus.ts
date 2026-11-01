import os from "node:os";

import { toError } from "@shared/util";
import { registerShutdownTask } from "../lifecycle";
import { lyricsDispatcher } from "../lyrics";
import { playbackController } from "../mediaSession";
import DbusLyricsService from "./DbusLyricsService";

/** The well-known name that owns the app's custom D-Bus services. */
export const DBUS_LYRICS_BUS_NAME = "io.github.yucling.OpenOrpheus";
/** The object path of the lyrics service. */
export const DBUS_LYRICS_OBJECT_PATH = "/io/github/yucling/OpenOrpheus/Lyrics";
/** The lyrics D-Bus interface. */
export const DBUS_LYRICS_INTERFACE = "io.github.yucling.OpenOrpheus.Lyrics";

let instance: DbusLyricsService | null = null;
let creating: Promise<DbusLyricsService | null> | null = null;

/**
 * Start the D-Bus lyrics service.
 *
 * Linux only: `@open-orpheus/dbus` is a Linux native module. The listener
 * wiring is event-driven, so an idle app does no periodic work. Failures are
 * logged and reported as `null` rather than aborting startup — the rest of the
 * app (and MPRIS) must keep working without a session bus.
 */
export async function createDbusLyricsService(): Promise<DbusLyricsService | null> {
  if (os.platform() !== "linux") {
    LOGGER.debug({ platform: os.platform() }, "D-Bus lyrics service skipped on this platform");
    return null;
  }
  if (instance) return instance;
  if (creating) return creating;

  creating = create().finally(() => {
    creating = null;
  });
  return creating;
}

async function create(): Promise<DbusLyricsService | null> {
  try {
    const { LyricsService } = await import("@open-orpheus/dbus");
    const service = new LyricsService(DBUS_LYRICS_BUS_NAME, DBUS_LYRICS_OBJECT_PATH);
    // The constructor only validates arguments; connecting, registering the
    // object, and requesting the bus name happen off the JS thread.
    await service.start();
    const adapter = new DbusLyricsService({
      service,
      lyrics: lyricsDispatcher,
      playback: playbackController,
      onError: (error, operation) => {
        LOGGER.warn({ err: toError(error), operation }, "D-Bus lyrics service update failed");
      },
    });

    instance = adapter;
    registerShutdownTask({
      name: "dbus-lyrics-service",
      run: () => adapter.dispose(),
    });
    LOGGER.info(
      { busName: DBUS_LYRICS_BUS_NAME, objectPath: DBUS_LYRICS_OBJECT_PATH },
      "D-Bus lyrics service started"
    );
    return adapter;
  } catch (error) {
    LOGGER.warn({ err: toError(error) }, "D-Bus lyrics service is unavailable");
    return null;
  }
}
