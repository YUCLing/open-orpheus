import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PluginKind } from "@shared/contracts/plugin-manager-api";

import { discoverPluginSources, loadDiscoveredPlugin } from "../../../src/main/plugin/discover";

let root: string;
let pluginsDir: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "open-orpheus-plugins-"));
  pluginsDir = path.join(root, "plugins");

  const plugin = path.join(pluginsDir, "org.example.one");
  await mkdir(path.join(plugin, "main"), { recursive: true });
  await writeFile(
    path.join(plugin, "metadata.json"),
    JSON.stringify({
      id: "org.example.one",
      name: "One",
      version: "1.0.0",
      realms: { main: "main/index.mjs" },
    })
  );
  await writeFile(path.join(plugin, "main/index.mjs"), "export function activate() {}\n");
  await writeFile(path.join(pluginsDir, "not-a-plugin.txt"), "");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("plugin discovery", () => {
  it("finds directories and assigns the location kind", async () => {
    expect(await discoverPluginSources([{ dir: pluginsDir, kind: PluginKind.User }])).toEqual([
      {
        source: path.join(pluginsDir, "org.example.one"),
        kind: PluginKind.User,
      },
    ]);
  });

  it("loads metadata and resolves the main entry", async () => {
    const plugin = await loadDiscoveredPlugin(
      path.join(pluginsDir, "org.example.one"),
      PluginKind.User
    );

    expect(plugin.metadata.id).toBe("org.example.one");
    expect(plugin.kind).toBe(PluginKind.User);
    expect(plugin.entryPaths.main).toBe(path.join(pluginsDir, "org.example.one", "main/index.mjs"));
  });

  it("rejects a tree without the declared main entry", async () => {
    const broken = path.join(pluginsDir, "org.example.broken");
    await mkdir(broken, { recursive: true });
    await writeFile(
      path.join(broken, "metadata.json"),
      JSON.stringify({
        id: "org.example.broken",
        name: "Broken",
        version: "1.0.0",
        realms: { main: "main/index.mjs" },
      })
    );

    await expect(loadDiscoveredPlugin(broken)).rejects.toThrow(/missing its main entry/);
  });

  it("accepts builtin metadata only for builtin plugins", async () => {
    const plugin = path.join(pluginsDir, "org.example.builtin-flag");
    await mkdir(path.join(plugin, "main"), { recursive: true });
    await writeFile(
      path.join(plugin, "metadata.json"),
      JSON.stringify({
        id: "org.example.builtin-flag",
        name: "Flagged",
        version: "1.0.0",
        realms: { main: "main/index.mjs" },
        builtin: { defaultEnabled: true },
      })
    );
    await writeFile(path.join(plugin, "main/index.mjs"), "export function activate() {}\n");

    await expect(loadDiscoveredPlugin(plugin, PluginKind.User)).rejects.toThrow(/builtin metadata/);

    const builtin = await loadDiscoveredPlugin(plugin, PluginKind.Builtin);
    expect(builtin.metadata.builtin?.defaultEnabled).toBe(true);
  });

  it("accepts a configuration module under assets", async () => {
    const plugin = path.join(pluginsDir, "org.example.configured");
    await mkdir(path.join(plugin, "main"), { recursive: true });
    await mkdir(path.join(plugin, "assets", "configuration"), { recursive: true });
    await writeFile(
      path.join(plugin, "metadata.json"),
      JSON.stringify({
        id: "org.example.configured",
        name: "Configured",
        version: "1.0.0",
        configuration: "configuration/index.mjs",
        realms: { main: "main/index.mjs" },
      })
    );
    await writeFile(path.join(plugin, "main/index.mjs"), "export function activate() {}\n");
    await writeFile(
      path.join(plugin, "assets/configuration/index.mjs"),
      "export function mount() {}\n"
    );

    const discovered = await loadDiscoveredPlugin(plugin, PluginKind.User);
    expect(discovered.metadata.configuration).toBe("configuration/index.mjs");
  });

  it("rejects a tree without the declared configuration entry", async () => {
    const plugin = path.join(pluginsDir, "org.example.missing-configuration");
    await mkdir(path.join(plugin, "main"), { recursive: true });
    await writeFile(
      path.join(plugin, "metadata.json"),
      JSON.stringify({
        id: "org.example.missing-configuration",
        name: "Missing Configuration",
        version: "1.0.0",
        configuration: "configuration/index.mjs",
        realms: { main: "main/index.mjs" },
      })
    );
    await writeFile(path.join(plugin, "main/index.mjs"), "export function activate() {}\n");

    await expect(loadDiscoveredPlugin(plugin)).rejects.toThrow(/configuration entry/);
  });

  it("resolves a plugin-manager entry", async () => {
    const plugin = path.join(pluginsDir, "org.example.plugin-manager");
    await mkdir(path.join(plugin, "main"), { recursive: true });
    await mkdir(path.join(plugin, "plugin-manager"), { recursive: true });
    await writeFile(
      path.join(plugin, "metadata.json"),
      JSON.stringify({
        id: "org.example.plugin-manager",
        name: "Plugin Manager",
        version: "1.0.0",
        realms: {
          main: "main/index.mjs",
          "plugin-manager": "plugin-manager/index.cjs",
        },
      })
    );
    await writeFile(path.join(plugin, "main/index.mjs"), "export function activate() {}\n");
    await writeFile(
      path.join(plugin, "plugin-manager/index.cjs"),
      "module.exports = { activate() {} };\n"
    );

    const discovered = await loadDiscoveredPlugin(plugin, PluginKind.User);
    expect(discovered.entryPaths["plugin-manager"]).toBe(
      path.join(plugin, "plugin-manager/index.cjs")
    );
  });
});
