import { execFile } from "node:child_process";
import { promisify } from "node:util";

import test from "ava";

import { DbusClient, MediaSession, PlaybackStatus } from "../index.js";

const execFileAsync = promisify(execFile);

const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";

/**
 * The MPRIS surface can only be exercised against a session bus, so these tests
 * skip on machines that have none (they are not part of the main vitest run).
 */
const serial = process.env.DBUS_SESSION_BUS_ADDRESS ? test.serial : test.serial.skip;

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
async function callPlayer(destination: string, method: string, ...args: string[]): Promise<string> {
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
async function getProperty(destination: string, property: string): Promise<string> {
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
  // `gdbus` renders values as `(<0.25>,)` / `(<'Playing'>,)`, and 64-bit
  // integers with an explicit type tag (`<int64 123>`).
  return stdout
    .replace(/[()<>',]/g, "")
    .replace(/\b(?:u?int(?:8|16|32|64))\b/g, "")
    .trim();
}

async function getPosition(destination: string): Promise<number> {
  return Number(await getProperty(destination, "Position"));
}

async function setProperty(destination: string, property: string, value: string): Promise<void> {
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
    property,
    value,
  ]);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

serial("lets a handler write back the volume a D-Bus property set reports", async (t) => {
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
});

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

serial(
  "advertises writable playback modes and waits for the renderer before replying",
  async (t) => {
    const { session, destination } = newSession();
    const { stdout: xml } = await execFileAsync("gdbus", [
      "introspect",
      "--session",
      "--dest",
      destination,
      "--object-path",
      OBJECT_PATH,
      "--xml",
    ]);
    t.regex(xml, /<property[^>]*name="Shuffle"[^>]*access="readwrite"/);
    t.regex(xml, /<property[^>]*name="LoopStatus"[^>]*access="readwrite"/);

    session.setEventHandler(async (_err, event) => {
      if (event.type === "SetShuffle") {
        await sleep(30);
        await session.setPlaybackMode("Playlist", event.shuffle);
      } else if (event.type === "SetLoopStatus") {
        await sleep(30);
        await session.setPlaybackMode(event.loopStatus, false);
      }
    });

    await setProperty(destination, "Shuffle", "<true>");
    t.is(await getProperty(destination, "Shuffle"), "true");
    t.is(await getProperty(destination, "LoopStatus"), "Playlist");
    for (const status of ["Track", "None", "Playlist"]) {
      await setProperty(destination, "LoopStatus", `<'${status}'>`);
      t.is(await getProperty(destination, "LoopStatus"), status);
      t.is(await getProperty(destination, "Shuffle"), "false");
    }
  }
);

serial("rejects invalid or unconfirmed mode writes without changing properties", async (t) => {
  const { session, destination } = newSession();
  session.setEventHandler(async () => {
    throw new Error("mode was not confirmed");
  });
  const invalid = await t.throwsAsync(setProperty(destination, "LoopStatus", "<'invalid'>"));
  t.regex(errorText(invalid), /InvalidArgs/);
  const rejected = await t.throwsAsync(setProperty(destination, "Shuffle", "<true>"));
  t.regex(errorText(rejected), /mode was not confirmed/);
  session.setEventHandler(null);
  const missing = await t.throwsAsync(setProperty(destination, "LoopStatus", "<'Track'>"));
  t.regex(errorText(missing), /No media session event handler/);
  t.is(await getProperty(destination, "LoopStatus"), "None");
  t.is(await getProperty(destination, "Shuffle"), "false");
});

serial("publishes in-app mode changes together and suppresses unchanged signals", async (t) => {
  const { session, destination } = newSession();
  const client = new DbusClient("session");
  const changes: unknown[][] = [];
  const subscription = await client.subscribe(
    {
      sender: destination,
      path: OBJECT_PATH,
      interfaceName: PROPERTIES_INTERFACE,
      member: "PropertiesChanged",
    },
    (_err, signal) => {
      changes.push(signal.body);
    }
  );
  try {
    await session.setPlaybackMode("Playlist", true);
    // The Get round trip also lets the queued signal reach the JS handler.
    t.is(await getProperty(destination, "Shuffle"), "true");
    await sleep(30);
    t.deepEqual(changes, [
      [
        PLAYER_INTERFACE,
        {
          LoopStatus: { signature: "s", value: "Playlist" },
          Shuffle: { signature: "b", value: true },
        },
        [],
      ],
    ]);
    await session.setPlaybackMode("Playlist", true);
    await sleep(30);
    t.is(changes.length, 1);
  } finally {
    subscription.unsubscribe();
    await client.disconnect();
  }
});

serial("interpolates Position between the throttled updates", async (t) => {
  const { session, destination } = newSession();

  await session.updatePlaybackState({
    status: PlaybackStatus.Playing,
    position: 1_000_000,
    speed: 1,
    advancing: true,
  });

  const first = await getPosition(destination);
  await sleep(250);
  const second = await getPosition(destination);
  const delta = second - first;

  t.true(delta >= 100_000, `Position only advanced ${delta} µs`);
  t.true(delta < 900_000, `Position advanced a full stale interval: ${delta} µs`);
});

serial("freezes Position while paused and does not trust the stale pause position", async (t) => {
  const { session, destination } = newSession();

  await session.updatePlaybackState({
    status: PlaybackStatus.Playing,
    position: 2_000_000,
    speed: 1,
    advancing: true,
  });
  await sleep(200);

  // The adapter's cached position is stale at pause time; the native clock
  // must freeze where it actually reached instead.
  await session.updatePlaybackState({
    status: PlaybackStatus.Paused,
    position: 2_000_000,
    speed: 1,
    advancing: false,
  });

  const paused = await getPosition(destination);
  t.true(paused >= 2_100_000, `pause froze too early at ${paused} µs`);

  await sleep(250);
  t.is(await getPosition(destination), paused);
});

serial("freezes Position during a buffering stall without changing the status", async (t) => {
  const { session, destination } = newSession();

  await session.updatePlaybackState({
    status: PlaybackStatus.Playing,
    position: 1_000_000,
    speed: 1,
    advancing: true,
  });
  await sleep(150);

  await session.updatePlaybackState({
    status: PlaybackStatus.Playing,
    position: 1_000_000,
    speed: 1,
    advancing: false,
  });

  const stalled = await getPosition(destination);
  t.true(stalled >= 1_100_000, `stall froze too early at ${stalled} µs`);
  t.is(await getProperty(destination, "PlaybackStatus"), "Playing");

  await sleep(250);
  t.is(await getPosition(destination), stalled);
});

serial("treats a paused seek as authoritative", async (t) => {
  const { session, destination } = newSession();

  await session.updatePlaybackState({
    status: PlaybackStatus.Paused,
    position: 30_000_000,
    speed: 1,
    advancing: false,
    seeked: true,
  });

  t.is(await getPosition(destination), 30_000_000);
});

serial("resets Position when the track changes", async (t) => {
  const { session, destination } = newSession();

  await session.setMetadata({ trackId: "/com/163/music/1" });
  await session.updatePlaybackState({
    status: PlaybackStatus.Playing,
    position: 50_000_000,
    speed: 1,
    advancing: true,
  });

  await session.setMetadata({ trackId: "/com/163/music/2" });
  const position = await getPosition(destination);

  t.true(position < 200_000, `new track started at ${position} µs`);
});
