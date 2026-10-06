import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAppImage } from "../../packaging/appimage/image";
import { resolveRuntime } from "../../packaging/appimage/runtime";
import { readPackageJson } from "../../packaging/common/package-json";

/** `\x7fELF` + a marker byte, so the fixtures are distinguishable and pass the ELF check. */
const runtimeBytes = (marker: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0x7f, 0x45, 0x4c, 0x46, marker]);

const URL_A = "https://example.test/runtime-a-x86_64";
const URL_B = "https://example.test/runtime-b-x86_64";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "appimage-spec-"));
  roots.push(root);
  return root;
}

/** Serve `bodies` over a stubbed `fetch`, yielding first so concurrent calls interleave. */
function stubFetch(bodies: Record<string, Uint8Array<ArrayBuffer>>) {
  const fetches = vi.fn(async (url: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const body = bodies[url];
    return body ? new Response(body, { status: 200 }) : new Response("missing", { status: 404 });
  });
  vi.stubGlobal("fetch", fetches);
  return fetches;
}

/** A throwaway packaged-app layout: just the executable the AppDir expects. */
async function fakeApp(projectRoot: string) {
  const appDir = join(projectRoot, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "open-orpheus"), "#!/bin/sh\n");
  await mkdir(join(projectRoot, "assets"), { recursive: true });
  await writeFile(join(projectRoot, "assets", "icon_256.png"), "fake-png");
  return appDir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveRuntime", () => {
  it("does not reuse a cache entry belonging to another source URL", async () => {
    const projectRoot = await tempRoot();
    const fetches = stubFetch({ [URL_A]: runtimeBytes(0x41), [URL_B]: runtimeBytes(0x42) });

    const first = await resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_A });
    const second = await resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_B });

    // The second call must download its own runtime instead of serving the first one's cache.
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(first[4]).toBe(0x41);
    expect(second[4]).toBe(0x42);
  });

  it("reuses the cache of the same source URL", async () => {
    const projectRoot = await tempRoot();
    const fetches = stubFetch({ [URL_A]: runtimeBytes(0x41) });

    await resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_A });
    const cached = await resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_A });

    expect(fetches).toHaveBeenCalledTimes(1);
    expect(cached[4]).toBe(0x41);
  });

  it("lets two concurrent downloads of one runtime both succeed", async () => {
    const projectRoot = await tempRoot();
    const fetches = stubFetch({ [URL_A]: runtimeBytes(0x41) });

    const [first, second] = await Promise.all([
      resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_A }),
      resolveRuntime({ projectRoot, arch: "x86_64", runtime: URL_A }),
    ]);

    expect(fetches).toHaveBeenCalledTimes(2);
    expect(first[4]).toBe(0x41);
    expect(second[4]).toBe(0x41);
  });

  it("rejects immediately for a missing local runtime", async () => {
    const projectRoot = await tempRoot();

    await expect(
      resolveRuntime({ projectRoot, arch: "x86_64", runtime: "does-not-exist" })
    ).rejects.toThrow(/not found/);
  });
});

describe("readPackageJson", () => {
  it("reads the package.json of the given tree, not this checkout's", async () => {
    const projectRoot = await tempRoot();
    await writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "other-app", version: "9.9.9" })
    );

    const pkg = await readPackageJson(projectRoot);

    expect(pkg.name).toBe("other-app");
    expect(pkg.version).toBe("9.9.9");
  });
});

describe("buildAppImage", () => {
  it("reports a missing runtime instead of crashing on an unhandled rejection", async () => {
    const projectRoot = await tempRoot();
    const appDir = await fakeApp(projectRoot);
    const outDir = join(projectRoot, "out");

    // The runtime rejection lands while the AppDir is still being assembled: it has to surface
    // as a rejection here, because an unhandled rejection would kill the process instead.
    await expect(
      buildAppImage({
        projectRoot,
        appDir,
        outDir,
        name: "open-orpheus",
        version: "0.0.0",
        arch: "x86_64",
        icon: { "256x256": "assets/icon_256.png" },
        runtime: "missing-runtime-file",
      })
    ).rejects.toThrow(/not found/);

    // Nothing was squashed or published, so the caller has nothing stale to clean up.
    await expect(readFile(join(outDir, "open-orpheus-0.0.0-x86_64.AppImage"))).rejects.toThrow();
  });
});
