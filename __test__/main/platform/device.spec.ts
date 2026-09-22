import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/open-orpheus-test/${name}`),
  },
  BrowserWindow: vi.fn(),
  screen: { getDisplayMatching: vi.fn() },
}));

import { vol } from "memfs";

import { data } from "@main/platform/folders";
import { installLoggerStub } from "../../helpers/globals";

const DEVICE_ID_PATH = `${data}/device_id.json`;

/** Re-import the module so its module-level device ID state starts empty. */
async function freshDeviceModule() {
  vi.resetModules();
  return await import("@main/platform/device");
}

describe("prepareDeviceId", () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync(data, { recursive: true });
    installLoggerStub();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates and persists a device ID pair", async () => {
    const device = await freshDeviceModule();

    expect(device.getDeviceId()).toBe("");
    expect(device.getADDeviceId()).toBe("");

    await device.prepareDeviceId();

    const deviceId = device.getDeviceId();
    const adDeviceId = device.getADDeviceId();

    expect(deviceId).toMatch(/^[0-9A-F]{52}$/);
    // "<mac>@@@<hex token>@@@@@@<sha256>" with an uppercase unicast MAC.
    expect(adDeviceId).toMatch(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){5}@@@[0-9A-F]+@{6}[0-9a-f]{64}$/
    );
    expect(adDeviceId.split("@@@")[0]).toMatch(
      /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/
    );

    const persisted = JSON.parse(
      vol.readFileSync(DEVICE_ID_PATH, "utf-8") as string
    );
    expect(persisted).toEqual({ deviceId, ADDeviceId: adDeviceId });
  });

  it("generates a unicast MAC address", async () => {
    const device = await freshDeviceModule();
    await device.prepareDeviceId();

    const mac = device.getADDeviceId().split("@@@")[0];
    const firstOctet = Number.parseInt(mac.slice(0, 2), 16);

    expect(firstOctet & 0x01).toBe(0); // unicast
    expect(firstOctet & 0x02).toBe(0); // universally administered
  });

  it("reuses the persisted IDs on the next run", async () => {
    const first = await freshDeviceModule();
    await first.prepareDeviceId();
    const deviceId = first.getDeviceId();
    const adDeviceId = first.getADDeviceId();

    const second = await freshDeviceModule();
    await second.prepareDeviceId();

    expect(second.getDeviceId()).toBe(deviceId);
    expect(second.getADDeviceId()).toBe(adDeviceId);
  });

  it("regenerates when the stored file is corrupt", async () => {
    const logger = installLoggerStub();
    vol.writeFileSync(DEVICE_ID_PATH, "not json at all");

    const device = await freshDeviceModule();
    await device.prepareDeviceId();

    expect(logger.warn).toHaveBeenCalled();
    expect(device.getDeviceId()).toMatch(/^[0-9A-F]{52}$/);
  });

  it("regenerates when the stored file is incomplete", async () => {
    vol.writeFileSync(
      DEVICE_ID_PATH,
      JSON.stringify({ deviceId: "ABCD", ADDeviceId: "" })
    );

    const device = await freshDeviceModule();
    await device.prepareDeviceId();

    expect(device.getDeviceId()).not.toBe("ABCD");
    expect(device.getDeviceId()).toMatch(/^[0-9A-F]{52}$/);
  });
});
