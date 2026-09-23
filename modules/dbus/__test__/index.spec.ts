import { execFile } from "node:child_process";
import { promisify } from "node:util";

import test from "ava";

import { MediaSession, PlaybackStatus } from "../index.js";

const execFileAsync = promisify(execFile);

const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";

/**
 * The MPRIS surface can only be exercised against a session bus, so these tests
 * skip on machines that have none (they are not part of the main vitest run).
 */
const serial = process.env.DBUS_SESSION_BUS_ADDRESS
  ? test.serial
  : test.serial.skip;

let sessionCounter = 0;
const sessions: MediaSession[] = [];

/** A fresh media session; each test owns its own well-known bus name. */
function newSession(): { session: MediaSession; destination: string } {
  const name = `open-orpheus-dbus-test-${process.pid}-${sessionCounter++}`;
  const session = new MediaSession(name, "Open Orpheus Test", "open-orpheus");
  sessions.push(session);
  return { session, destination: `org.mpris.MediaPlayer2.${name}` };
}

// A registered event handler keeps the process alive through its native
// threadsafe function; drop them all so ava can exit.
test.after.always(() => {
  for (const session of sessions) session.setEventHandler(null);
});

/** Invoke a player method and resolve with `gdbus`'s output. */
async function callPlayer(
  destination: string,
  method: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync("gdbus", [
    "call",
    "--session",
    "--dest",
    destination,
    "--object-path",
    OBJECT_PATH,
    "--method",
    `${PLAYER_INTERFACE}.${method}`,
    ...args,
  ]);
  return stdout;
}

/** Read a player property, unwrapping `gdbus`'s `<value>` / `'value'` syntax. */
async function getProperty(
  destination: string,
  property: string
): Promise<string> {
  const { stdout } = await execFileAsync("gdbus", [
    "call",
    "--session",
    "--dest",
    destination,
    "--object-path",
    OBJECT_PATH,
    "--method",
    `${PROPERTIES_INTERFACE}.Get`,
    PLAYER_INTERFACE,
    property,
  ]);
  // `gdbus` renders values as `(<0.25>,)` / `(<'Playing'>,)`.
  return stdout.replace(/[()<>',]/g, "").trim();
}

function errorText(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message?: string };
  return stderr ?? message ?? String(error);
}

serial("waits for an async handler to settle before replying", async (t) => {
  const { session, destination } = newSession();
  const order: string[] = [];

  session.setEventHandler(async (_err, event) => {
    if (event.type !== "Play") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    order.push("handler");
  });

  await callPlayer(destination, "Play");
  order.push("reply");

  t.deepEqual(order, ["handler", "reply"]);
});

serial("lets a handler update properties without deadlocking", async (t) => {
  const { session, destination } = newSession();
  const order: string[] = [];

  session.setEventHandler(async (_err, event) => {
    if (event.type !== "Play") return;
    // Each of these used to need the interface write lock, which an in-flight
    // command holds a read lock on — awaiting them deadlocked the command.
    await session.setVolume(0.25);
    await session.updatePlaybackState({
      status: PlaybackStatus.Playing,
      position: 1_000_000,
      speed: 1,
    });
    order.push("updated");
  });

  await callPlayer(destination, "Play");
  order.push("reply");

  t.deepEqual(order, ["updated", "reply"]);
  t.is(await getProperty(destination, "Volume"), "0.25");
  t.is(await getProperty(destination, "PlaybackStatus"), "Playing");
});

serial(
  "lets a handler write back the volume a D-Bus property set reports",
  async (t) => {
    const { session, destination } = newSession();

    session.setEventHandler(async (_err, event) => {
      if (event.type !== "SetVolume") return;
      // The property set that delivered this event holds the interface's read
      // lock while it waits here, so writing the property back must not need
      // the write lock.
      await session.setVolume(event.volume);
    });

    await execFileAsync("gdbus", [
      "call",
      "--session",
      "--dest",
      destination,
      "--object-path",
      OBJECT_PATH,
      "--method",
      `${PROPERTIES_INTERFACE}.Set`,
      PLAYER_INTERFACE,
      "Volume",
      "<0.5>",
    ]);

    t.is(await getProperty(destination, "Volume"), "0.5");
  }
);

serial("propagates a rejected handler back to the caller", async (t) => {
  const { session, destination } = newSession();
  session.setEventHandler(async () => {
    throw new Error("handler failed");
  });

  const error = await t.throwsAsync(callPlayer(destination, "Next"));
  t.regex(errorText(error), /handler failed/);
});

serial("reports a missing handler instead of hanging", async (t) => {
  const { session, destination } = newSession();
  session.setEventHandler(() => {});
  session.setEventHandler(null);

  const error = await t.throwsAsync(callPlayer(destination, "Play"));
  t.regex(errorText(error), /No media session event handler is registered/);
  t.truthy(session);
});
