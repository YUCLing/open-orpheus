import { describe, expect, it, vi } from "vitest";

import {
  PluginConfigurationFailureStage,
  PluginConfigurationStateKind,
  type PluginRealmActivationOutcome,
} from "@shared/contracts/plugin-configuration";

import {
  PluginConfigurationLoader,
  type PluginConfigurationRequest,
} from "../../gui/src/lib/plugin-configuration/loader";

const root = {} as HTMLDivElement;

function request(overrides: Partial<PluginConfigurationRequest> = {}): PluginConfigurationRequest {
  return {
    pluginId: "p",
    entryUrl: "assets://plugins/p/configuration/index.mjs",
    revision: 1,
    requiresPreload: false,
    root,
    ...overrides,
  };
}

function createLoader(
  importModule: (url: string) => Promise<unknown>,
  waitForRealm: (pluginId: string) => Promise<PluginRealmActivationOutcome> = async () => ({
    kind: "running",
  })
): PluginConfigurationLoader {
  return new PluginConfigurationLoader({ importModule, waitForRealm });
}

describe("PluginConfigurationLoader", () => {
  it("imports, mounts, and unmounts with a fresh evaluation URL", async () => {
    const unmount = vi.fn();
    const mount = vi.fn(() => unmount);
    const importModule = vi.fn(async () => ({ mount }));
    const loader = createLoader(importModule);

    await loader.open(request());

    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith(
      expect.stringMatching(/^assets:\/\/plugins\/p\/configuration\/index\.mjs\?t=\d+-[a-z0-9]+$/)
    );

    await loader.close("p");
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Ready);

    await loader.open(request());
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it("waits for the plugin-manager preload realm before importing", async () => {
    const order: string[] = [];
    let release!: (outcome: PluginRealmActivationOutcome) => void;
    const loader = createLoader(
      async () => {
        order.push("import");
        return { mount: () => () => {} };
      },
      () => {
        order.push("wait");
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    );

    const opening = loader.open(request({ requiresPreload: true }));
    await vi.waitFor(() =>
      expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.WaitingForPreload)
    );
    release({ kind: "running" });
    await opening;

    expect(order).toEqual(["wait", "import"]);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);
  });

  it("blocks mounting when the preload realm fails", async () => {
    const importModule = vi.fn();
    const loader = createLoader(importModule, async () => ({
      kind: "failed",
      error: "preload exploded",
    }));

    await loader.open(request({ requiresPreload: true }));

    expect(importModule).not.toHaveBeenCalled();
    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Preload,
      error: "preload exploded",
      retryable: false,
    });
  });

  it("discards an import that settles after dispose", async () => {
    let resolveImport!: (value: unknown) => void;
    const mount = vi.fn();
    const loader = createLoader(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        })
    );

    const opening = loader.open(request());
    await vi.waitFor(() => expect(resolveImport).toBeTypeOf("function"));
    const disposing = loader.dispose("p", 1);
    resolveImport({ mount });
    await Promise.all([opening, disposing]);

    expect(mount).not.toHaveBeenCalled();
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });

  it("runs cleanup returned after the mount became stale", async () => {
    let resolveMount!: (value: unknown) => void;
    const unmount = vi.fn();
    const loader = createLoader(async () => ({
      mount: () =>
        new Promise((resolve) => {
          resolveMount = resolve;
        }),
    }));

    const opening = loader.open(request());
    await vi.waitFor(() => expect(resolveMount).toBeTypeOf("function"));

    const disposing = loader.dispose("p");
    resolveMount(unmount);
    await Promise.all([opening, disposing]);

    expect(unmount).toHaveBeenCalledTimes(1);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });

  it("rejects a module without mount()", async () => {
    const loader = createLoader(async () => ({}));

    await loader.open(request());

    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Validate,
      retryable: true,
    });
  });

  it("reports mount failures", async () => {
    const loader = createLoader(async () => ({
      mount: () => {
        throw new Error("mount exploded");
      },
    }));

    await loader.open(request());

    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Mount,
      error: "mount exploded",
    });
  });

  it("accepts mount() returning no cleanup", async () => {
    const loader = createLoader(async () => ({ mount: () => undefined }));

    await loader.open(request());
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);

    await loader.close("p");
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Ready);
  });

  it("rejects a mount result that is not a function", async () => {
    const loader = createLoader(async () => ({ mount: () => ({}) }));

    await loader.open(request());

    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Mount,
      error: expect.stringContaining("must return an unmount function or nothing"),
    });
  });

  it("retries from a new evaluation epoch", async () => {
    const urls: string[] = [];
    const loader = createLoader(async (url) => {
      urls.push(url);
      if (urls.length === 1) throw new Error("import exploded");
      return { mount: () => () => {} };
    });

    await loader.open(request());
    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Import,
    });

    await loader.retry(request());

    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);
  });

  it("drops a cached module when the desired revision advances", async () => {
    const importModule = vi.fn(async () => ({ mount: () => () => {} }));
    const loader = createLoader(importModule);

    await loader.open(request({ revision: 1 }));
    await loader.close("p");
    await loader.open(request({ revision: 2 }));

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);
  });

  it("retains a failed unmount so cleanup can be retried", async () => {
    const unmount = vi
      .fn()
      .mockRejectedValueOnce(new Error("unmount exploded"))
      .mockResolvedValue(undefined);
    const loader = createLoader(async () => ({ mount: () => unmount }));

    await loader.open(request());
    await loader.dispose("p");

    expect(loader.snapshot().p).toMatchObject({
      kind: PluginConfigurationStateKind.Failed,
      stage: PluginConfigurationFailureStage.Unmount,
      error: "unmount exploded",
    });

    await loader.dispose("p");

    expect(unmount).toHaveBeenCalledTimes(2);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });

  it("keeps a newer mount when a stale dispose acknowledges", async () => {
    const loader = createLoader(async () => ({ mount: () => () => {} }));

    await loader.open(request({ revision: 2 }));
    await loader.dispose("p", 1);

    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Mounted);
  });

  it("passes the plugin assets root as assetsBaseUrl", async () => {
    let base: string | undefined;
    const loader = createLoader(async () => ({
      mount: (_root: HTMLDivElement, context: { assetsBaseUrl: string }) => {
        base = context.assetsBaseUrl;
        return () => {};
      },
    }));

    await loader.open(request());

    expect(base).toBe("assets://plugins/p/");
  });

  it("aborts an in-flight mount as soon as the panel closes", async () => {
    let signal: AbortSignal | undefined;
    const loader = createLoader(async () => ({
      mount: (_root: HTMLDivElement, context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = context.signal;
          context.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }));

    const opening = loader.open(request());
    await vi.waitFor(() => expect(signal).toBeDefined());

    const closing = loader.close("p");
    await Promise.all([opening, closing]);

    expect(signal?.aborted).toBe(true);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Ready);
  });

  it("aborts an in-flight mount as soon as the plugin is disposed", async () => {
    let signal: AbortSignal | undefined;
    const loader = createLoader(async () => ({
      mount: (_root: HTMLDivElement, context: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal = context.signal;
          context.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }));

    const opening = loader.open(request());
    await vi.waitFor(() => expect(signal).toBeDefined());

    const disposing = loader.dispose("p");
    await Promise.all([opening, disposing]);

    expect(signal?.aborted).toBe(true);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });

  it("breaks a preload wait when the plugin is disposed", async () => {
    const loader = createLoader(
      async () => ({ mount: () => () => {} }),
      () => new Promise<PluginRealmActivationOutcome>(() => {})
    );

    const opening = loader.open(request({ requiresPreload: true }));
    await vi.waitFor(() =>
      expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.WaitingForPreload)
    );

    const disposing = loader.dispose("p");
    const settled = await Promise.race([
      Promise.all([opening, disposing]).then(() => "done" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
    ]);

    expect(settled).toBe("done");
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });

  it("retains cleanup whose unmount fails after its mount became stale", async () => {
    let resolveMount!: (value: unknown) => void;
    const unmount = vi
      .fn()
      .mockRejectedValueOnce(new Error("stale unmount exploded"))
      .mockResolvedValue(undefined);
    const loader = createLoader(async () => ({
      mount: () =>
        new Promise((resolve) => {
          resolveMount = resolve;
        }),
    }));

    const opening = loader.open(request());
    await vi.waitFor(() => expect(resolveMount).toBeTypeOf("function"));

    const disposing = loader.dispose("p");
    resolveMount(unmount);
    await Promise.all([opening, disposing]);

    // The first unmount failed during stale cleanup; dispose retried it.
    expect(unmount).toHaveBeenCalledTimes(2);
    expect(loader.snapshot().p.kind).toBe(PluginConfigurationStateKind.Unloaded);
  });
});
