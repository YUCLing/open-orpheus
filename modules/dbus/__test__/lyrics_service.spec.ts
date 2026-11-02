import test from "ava";

import { DbusClient, LyricsService } from "../index.js";

/**
 * The service can only be exercised against a session bus, so these tests skip
 * on machines that have none (they are not part of the main vitest run).
 */
const serial = process.env.DBUS_SESSION_BUS_ADDRESS ? test.serial : test.serial.skip;

const OBJECT_PATH = "/io/github/yucling/OpenOrpheus/Lyrics";
const LYRICS_INTERFACE = "io.github.yucling.OpenOrpheus.Lyrics";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const BUS = {
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  interfaceName: "org.freedesktop.DBus",
};

let counter = 0;
const services: LyricsService[] = [];
const clients: DbusClient[] = [];

/** A fresh, started lyrics service; each test owns its own well-known bus name. */
async function newService(): Promise<{ service: LyricsService; destination: string }> {
  const name = `io.github.yucling.OpenOrpheus.test.p${process.pid}.t${counter++}`;
  const service = new LyricsService(name);
  await service.start();
  services.push(service);
  return { service, destination: name };
}

function newClient(): DbusClient {
  const client = new DbusClient("session");
  clients.push(client);
  return client;
}

test.after.always(async () => {
  await Promise.all(services.map((service) => service.dispose().catch(() => {})));
  await Promise.all(clients.map((client) => client.disconnect()));
});

/** Wait until `predicate` holds, failing if it never does. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a signal");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function getProperty(
  client: DbusClient,
  destination: string,
  name: string
): Promise<{ signature: string; value: unknown }> {
  return client.getProperty({
    destination,
    path: OBJECT_PATH,
    interfaceName: LYRICS_INTERFACE,
    name,
  });
}

const document = {
  regular: [
    {
      startTime: 0,
      endTime: 5_000,
      words: [{ text: "hello", startTime: 0, duration: 5_000 }],
    },
    {
      startTime: 5_000,
      endTime: 10_000,
      words: [{ text: "world", startTime: 0, duration: 5_000 }],
    },
  ],
  translate: [
    {
      startTime: 0,
      endTime: 5_000,
      words: [{ text: "你好", startTime: 0, duration: 5_000 }],
    },
  ],
};

serial("does not own the bus name until start()", async (t) => {
  const name = `io.github.yucling.OpenOrpheus.test.p${process.pid}.t${counter++}`;
  const service = new LyricsService(name);
  services.push(service);
  const client = newClient();

  const before = await client.call({
    ...BUS,
    method: "NameHasOwner",
    signature: "s",
    body: [name],
  });
  t.is(before.body[0], false);

  await service.start();

  const after = await client.call({
    ...BUS,
    method: "NameHasOwner",
    signature: "s",
    body: [name],
  });
  t.is(after.body[0], true);
});

serial("publishes lyrics, track properties, and line lookups", async (t) => {
  const { service, destination } = await newService();
  const client = newClient();

  await service.setTrack({
    id: "42",
    title: "title",
    artist: "artist",
    album: "album",
    duration: 240_000,
  });
  await service.setLyrics(document, null);

  const reply = await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: LYRICS_INTERFACE,
    method: "GetLyrics",
  });
  t.is(reply.signature, "s");
  const lyrics = JSON.parse(reply.body[0] as string) as {
    regular: Array<{ words: Array<{ text: string }> }>;
    translate: unknown[];
  };
  t.is(lyrics.regular[0]?.words[0]?.text, "hello");
  t.is(lyrics.regular[1]?.words[0]?.text, "world");
  t.true(Array.isArray(lyrics.translate));

  t.is((await getProperty(client, destination, "Available")).value, true);
  t.is((await getProperty(client, destination, "TrackId")).value, "42");
  t.is((await getProperty(client, destination, "Title")).value, "title");
  t.is((await getProperty(client, destination, "Artist")).value, "artist");
  t.is((await getProperty(client, destination, "Album")).value, "album");
  t.is((await getProperty(client, destination, "Duration")).value, 240_000);
  t.is((await getProperty(client, destination, "HasTranslation")).value, true);
  t.is((await getProperty(client, destination, "HasPerWord")).value, false);

  const line = await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: LYRICS_INTERFACE,
    method: "GetLineAt",
    signature: "x",
    body: [2_500],
  });
  const parsed = JSON.parse(line.body[0] as string) as {
    index: number;
    text: string;
    translation: string;
  };
  t.is(parsed.index, 0);
  t.is(parsed.text, "hello");
  t.is(parsed.translation, "你好");

  const before = await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: LYRICS_INTERFACE,
    method: "GetLineAt",
    signature: "x",
    body: [-1],
  });
  t.is(before.body[0], "null");
});

serial("publishes a slogan without lyrics", async (t) => {
  const { service, destination } = await newService();
  const client = newClient();

  await service.setLyrics(null, "enjoy the music");

  t.is((await getProperty(client, destination, "Slogan")).value, "enjoy the music");
  t.is((await getProperty(client, destination, "Available")).value, false);

  const reply = await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: LYRICS_INTERFACE,
    method: "GetLyrics",
  });
  t.is(reply.body[0], "null");
});

serial("emits LyricsChanged when the lyrics change", async (t) => {
  const { service, destination } = await newService();
  const client = newClient();
  let changes = 0;

  const subscription = await client.subscribe(
    { path: OBJECT_PATH, interfaceName: LYRICS_INTERFACE, member: "LyricsChanged" },
    () => {
      changes += 1;
    }
  );

  await service.setLyrics(document, null);
  await waitFor(() => changes > 0);
  subscription.unsubscribe();

  t.true(changes > 0);
  t.is((await getProperty(client, destination, "Available")).value, true);
});

serial("releases the well-known name on dispose", async (t) => {
  const { service, destination } = await newService();
  const client = newClient();

  await service.dispose();

  await waitFor(async () => {
    const reply = await client.call({
      ...BUS,
      method: "NameHasOwner",
      signature: "s",
      body: [destination],
    });
    return reply.body[0] === false;
  });
  t.pass();
});

serial("rejects an invalid object path", (t) => {
  t.throws(
    () =>
      new LyricsService(`io.github.yucling.OpenOrpheus.test.p${process.pid}.invalid`, "bad-path")
  );
});

serial("exposes the standard Properties interface", async (t) => {
  const { service, destination } = await newService();
  const client = newClient();
  await service.setLyrics(document, null);

  const reply = await client.call({
    destination,
    path: OBJECT_PATH,
    interfaceName: PROPERTIES_INTERFACE,
    method: "GetAll",
    signature: "s",
    body: [LYRICS_INTERFACE],
  });
  const properties = reply.body[0] as Record<string, { value: unknown }>;
  t.is(properties.Available?.value, true);
  t.is(properties.HasTranslation?.value, true);
  t.is(properties.Duration?.value, 0);
});
