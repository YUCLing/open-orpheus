import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async () => (await import("memfs")).fs.promises);

import { vol } from "memfs";

import { writeScaffold } from "../../packaging/common/scaffold";

describe.runIf(process.platform === "linux")("writeScaffold", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("writes the full install layout using default paths", async () => {
    vol.fromJSON({
      "app-src/package.json": "{}",
      "app-src/open-orpheus": "fake-binary",
      "app-src/resources/app.asar": "fake-asar",
      "desktop/open-orpheus.desktop": "[Desktop Entry]\nExec=open-orpheus\n",
      "icons/icon_256.png": "fake-png",
    });

    await writeScaffold("/root", {
      id: "open-orpheus",
      executable: "open-orpheus",
      input: {
        app: "app-src",
        icons: { "256x256": "icons/icon_256.png" },
        desktop: "desktop/open-orpheus.desktop",
      },
      paths: { symlink: true },
    });

    expect(vol.toSnapshot("/root")).toMatchSnapshot();
  });

  it("honours custom paths, appName and executable", async () => {
    vol.fromJSON({
      "app-src/foo": "fake-binary",
      "desktop/my-app.desktop": "[Desktop Entry]\nExec=foo\n",
      "icons/icon.svg": "<svg></svg>",
    });

    await writeScaffold("/staging", {
      id: "io.github.example.my-app",
      appName: "my-app",
      executable: "foo",
      input: {
        app: "app-src",
        icons: { scalable: "icons/icon.svg" },
        desktop: "desktop/my-app.desktop",
      },
      paths: {
        app: "/opt/my-app/",
        icons: { appName: "my-app", path: "/opt/my-app/icons/" },
        desktop: "/opt/my-app/my-app.desktop",
        symlink: "/opt/bin/my-app",
      },
    });

    expect(vol.toSnapshot("/staging")).toMatchSnapshot();
  });

  it("does not create a symlink when paths.symlink is omitted", async () => {
    vol.fromJSON({
      "app-src/open-orpheus": "fake-binary",
    });

    await writeScaffold("/root", {
      id: "open-orpheus",
      appName: "open-orpheus",
      executable: "open-orpheus",
      input: { app: "app-src" },
    });

    expect(vol.toSnapshot("/root")).toMatchSnapshot();
  });

  it("throws when the app name cannot be inferred", async () => {
    await expect(
      writeScaffold("/root", { id: "open-orpheus", executable: "open-orpheus" })
    ).rejects.toThrow("Cannot infer app name.");
  });
});
