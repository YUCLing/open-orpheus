import test from "ava";

import { DbusClient, MediaSession } from "../index.js";

/**
 * The client can only be exercised against a session bus, so these tests skip
 * on machines that have none (they are not part of the main vitest run).
 */
const serial = process.env.DBUS_SESSION_BUS_ADDRESS ? test.serial : test.serial.skip;

/** The bus itself implements a handful of well-known methods and properties. */
const BUS = {
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  interfaceName: "org.freedesktop.DBus",
};

const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";

let counter = 0;
const clients: DbusClient[] = [];
const sessions: MediaSession[] = [];
const subscriptions: Array<{ unsubscribe(): void }> = [];

function newClient(): DbusClient {
  const client = new DbusClient("session");
  clients.push(client);
  return client;
}

/** A fresh media session; each test owns its own well-known bus name. */
function newSession(): { session: MediaSession; destination: string } {
  const name = `open.orpheus.dbus.client.p${process.pid}.t${counter++}`;
  const session = new MediaSession(name, "Open Orpheus Test", "open-orpheus");
  sessions.push(session);
  return { session, destination: `org.mpris.MediaPlayer2.${name}` };
}

/** A unique, well-formed well-known bus name. */
function newBusName(): string {
  return `open.orpheus.dbus.client.p${process.pid}.t${counter++}`;
}

// A registered event handler keeps the process alive through its native
// threadsafe function; drop them all so ava can exit.
test.after.always(async () => {
  for (const subscription of subscriptions) subscription.unsubscribe();
  for (const session of sessions) session.setEventHandler(null);
  await Promise.all(clients.map((client) => client.disconnect()));
});

/** Wait until `predicate` holds, failing if it never does. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a signal");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

serial("calls methods and decodes their replies", async (t) => {
  const client = newClient();

  const id = await client.call({ ...BUS, method: "GetId" });
  t.is(id.signature, "s");
  t.is(id.body.length, 1);
  t.is(typeof id.body[0], "string");
  t.true((id.body[0] as string).length > 0);

  const hasOwner = await client.call({
    ...BUS,
    method: "NameHasOwner",
    signature: "s",
    body: ["org.freedesktop.DBus"],
  });
  t.is(hasOwner.signature, "b");
  t.is(hasOwner.body[0], true);

  const names = await client.call({ ...BUS, method: "ListNames" });
  t.is(names.signature, "as");
  t.true(Array.isArray(names.body[0]));
  t.true((names.body[0] as string[]).includes("org.freedesktop.DBus"));
});

serial("decodes integers as numbers and fds as null", async (t) => {
  const client = newClient();

  const pid = await client.call({
    ...BUS,
    method: "GetConnectionUnixProcessID",
    signature: "s",
    body: ["org.freedesktop.DBus"],
  });
  t.is(pid.signature, "u");
  t.is(pid.body.length, 1);
  t.is(typeof pid.body[0], "number");
  t.true((pid.body[0] as number) > 0);
});

serial("unwraps variants in dictionaries", async (t) => {
  const client = newClient();

  const credentials = await client.call({
    ...BUS,
    method: "GetConnectionCredentials",
    signature: "s",
    body: ["org.freedesktop.DBus"],
  });
  t.is(credentials.signature, "a{sv}");

  const dict = credentials.body[0] as Record<string, { signature: string; value: unknown }>;
  t.is(dict.ProcessID.signature, "u");
  t.is(typeof dict.ProcessID.value, "number");
  // Where the bus reports an fd handle (`ProcessFD`), it cannot cross the
  // boundary and is decoded as null rather than failing the whole reply.
  if (dict.ProcessFD) t.is(dict.ProcessFD.value, null);
});

serial("reads and writes properties", async (t) => {
  const client = newClient();

  const interfaces = await client.getProperty({ ...BUS, name: "Interfaces" });
  t.is(interfaces.signature, "as");
  t.true(Array.isArray(interfaces.value));

  // `Interfaces` is read-only, so the bus rejects the write and the error
  // travels back with its D-Bus name intact.
  const error = await t.throwsAsync(
    client.setProperty({
      ...BUS,
      name: "Interfaces",
      signature: "as",
      value: [],
    })
  );
  t.regex((error as Error).message, /org\.freedesktop\.DBus\.Error\.PropertyReadOnly/);
});

serial("rejects invalid calls", async (t) => {
  const client = newClient();

  const unknown = await t.throwsAsync(client.call({ ...BUS, method: "Nope" }));
  t.regex((unknown as Error).message, /org\.freedesktop\.DBus\.Error\.UnknownMethod/);

  const signature = await t.throwsAsync(
    client.call({ ...BUS, method: "NameHasOwner", signature: "z", body: ["x"] })
  );
  t.regex((signature as Error).message, /invalid D-Bus signature/);

  const arity = await t.throwsAsync(
    client.call({ ...BUS, method: "NameHasOwner", signature: "s" })
  );
  t.regex((arity as Error).message, /expects 1 argument/);

  const type = await t.throwsAsync(
    client.call({ ...BUS, method: "NameHasOwner", signature: "s", body: [1] })
  );
  t.regex((type as Error).message, /argument 0/);
});

serial("rejects a subscription with an invalid match", async (t) => {
  const client = newClient();

  const error = await t.throwsAsync(client.subscribe({ sender: "not a bus name" }, () => {}));
  t.regex((error as Error).message, /invalid signal sender/);
});

serial("delivers matching signals until unsubscribed", async (t) => {
  const client = newClient();
  const name = newBusName();
  const seen: string[] = [];

  const subscription = await client.subscribe(
    {
      sender: "org.freedesktop.DBus",
      interfaceName: "org.freedesktop.DBus",
      member: "NameOwnerChanged",
    },
    (_error, signal) => {
      seen.push(signal.body[0] as string);
    }
  );
  subscriptions.push(subscription);
  t.true(subscription.active);

  await client.call({
    ...BUS,
    method: "RequestName",
    signature: "su",
    body: [name, 0],
  });
  await waitFor(() => seen.includes(name));
  t.true(seen.includes(name));

  subscription.unsubscribe();
  subscription.unsubscribe(); // idempotent
  t.false(subscription.active);

  await client.call({
    ...BUS,
    method: "ReleaseName",
    signature: "s",
    body: [name],
  });
});

serial("drives the MPRIS server from the client", async (t) => {
  const client = newClient();
  const { session, destination } = newSession();
  const events: string[] = [];
  session.setEventHandler((_error, event) => {
    events.push(event.type);
  });

  const volume = await client.getProperty({
    destination,
    path: OBJECT_PATH,
    interfaceName: PLAYER_INTERFACE,
    name: "Volume",
  });
  t.is(volume.signature, "d");
  t.is(volume.value, 1);

  await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: PLAYER_INTERFACE,
    method: "Play",
  });
  t.deepEqual(events, ["Play"]);

  session.setEventHandler(async (_error, event) => {
    if (event.type === "SetVolume") await session.setVolume(event.volume);
  });
  await client.setProperty({
    destination,
    path: OBJECT_PATH,
    interfaceName: PLAYER_INTERFACE,
    name: "Volume",
    signature: "d",
    value: 0.25,
  });

  const updated = await client.getProperty({
    destination,
    path: OBJECT_PATH,
    interfaceName: PLAYER_INTERFACE,
    name: "Volume",
  });
  t.is(updated.value, 0.25);
});
