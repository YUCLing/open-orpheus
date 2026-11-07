import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import { redirectBuiltDownloadUrl, startPackageServer } from "./package-server";

const dataDir = process.env["OPEN_ORPHEUS_CUSTOM_DATA_DIR"]!;
const cachedPackage = process.env["OPEN_ORPHEUS_E2E_PACKAGE_FILE"];
const downloadUrl = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../versions.json"), "utf-8")) as {
    downloadUrl: string;
  }
).downloadUrl;

// Chromium switches for the app under test. CI passes `--no-sandbox
// --disable-gpu`: Actions runners cannot set up Chromium's sandbox, and Xvfb
// has no GPU.
const extraElectronArgs = (process.env["OPEN_ORPHEUS_E2E_ELECTRON_ARGS"] ?? "")
  .split(/\s+/)
  .filter(Boolean);

// CI restores the installer from a cache instead of pulling the ~160 MB file
// from NetEase's CDN on every run. Serving it from loopback keeps the real
// download + 7z-wasm extraction path, and it must happen before the app is
// launched: the URL is baked into the build output.
let packageServer: Awaited<ReturnType<typeof startPackageServer>> | undefined;
let restoreBundles: (() => void) | undefined;

test.beforeAll(async () => {
  if (!cachedPackage || !existsSync(cachedPackage)) return;
  packageServer = await startPackageServer(cachedPackage);
  restoreBundles = redirectBuiltDownloadUrl(downloadUrl, packageServer.url);
});

test.afterAll(async () => {
  restoreBundles?.();
  await packageServer?.close();
});

function launchApp() {
  return electron.launch({ args: [".", ...extraElectronArgs] });
}

// The web pack download pulls the ~160 MB installer and unpacks it with
// 7z-wasm in-process, which takes minutes on a CI runner.
const DOWNLOAD_TIMEOUT = 15 * 60_000;

test("package download", async () => {
  test.skip(existsSync(join(dataDir, "package")));
  test.setTimeout(DOWNLOAD_TIMEOUT);
  const electronApp = await launchApp();
  const window = await electronApp.firstWindow();
  await expect(window.getByText("缺少包文件")).toBeVisible();
  await window.getByRole("button", { name: "下载" }).click();
  await expect(window.getByText("正在下载")).toBeVisible();
  await window.waitForEvent("close", { timeout: DOWNLOAD_TIMEOUT });
  // close app
  await electronApp.close();
});

test.describe.serial("ncm app", () => {
  let electronApp: ElectronApplication;
  let mainWindow: Page;

  test.beforeAll(async () => {
    electronApp = await launchApp();
  });

  test.afterAll(async () => {
    await electronApp.close();
  });

  async function registerPopoverHandler(wnd: Page) {
    await wnd.addLocatorHandler(
      wnd.locator(".cmd-modal").first(),
      async (locator) => {
        await locator.getByRole("button", { name: "close" }).click();
      },
      { times: 3 }
    );
    await wnd.addLocatorHandler(
      wnd
        .locator(".cmd-popover")
        .filter({ has: wnd.locator(".cmd-icon-close") })
        .first(),
      async (locator) => {
        await locator.locator(".cmd-icon-close").click();
      },
      { times: 3 }
    );
    await wnd.addLocatorHandler(
      wnd.locator("[id^=dialog-]").first(),
      async (locator) => {
        await locator.getByRole("button", { name: "close" }).click();
      },
      { times: 3 }
    );
  }

  test("main window shows", async () => {
    mainWindow = await electronApp.firstWindow();
    await registerPopoverHandler(mainWindow);
  });

  test("app loads", async () => {
    await Promise.all(
      [
        // NCM Logo shows
        "tid_toparea_logo",
        // Account menu on navbar
        "tid_pc_nav_bar_account",
      ].map((v) => expect(mainWindow.getByTestId(v).first()).toBeAttached())
    );
  });

  test.describe("search and play", async () => {
    // Flaky because of new login modal
    test.fixme();
    test("can search", async () => {
      await mainWindow.getByTestId("tid_searchbox_input").fill("奔向刹那之后（刹那のその先へ）");
      await mainWindow.getByTestId("tid_searchbox_btn").click();
    });

    test("can play", async () => {
      const trackCard = mainWindow
        .getByTestId("tid_searchresults_content")
        .getByTestId("tid_cell_pc_common_songcard")
        .first();
      await expect(async () => {
        await trackCard.hover();
        await trackCard.getByTestId("tid_trackcard_play_btn").click({ timeout: 2000 });
      }).toPass({ timeout: 15_000 });
      await expect(mainWindow.getByTestId("tid_btn_pc_minibar_vinyl")).toBeAttached();
    });
  });
});
