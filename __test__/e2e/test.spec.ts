import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const dataDir = process.env["OPEN_ORPHEUS_CUSTOM_DATA_DIR"]!;

test("package download", async () => {
  test.skip(existsSync(join(dataDir, "package")));
  test.slow();
  const electronApp = await electron.launch({ args: ["."] });
  const window = await electronApp.firstWindow();
  expect(await window.getByText("缺少包文件").isVisible());
  await window.getByRole("button", { name: "下载" }).click();
  expect(await window.getByText("正在下载").isVisible());
  await window.waitForEvent("close", { timeout: 120_000 });
  // close app
  await electronApp.close();
});

test.describe("ncm app", () => {
  let electronApp: ElectronApplication;
  let mainWindow: Page;

  test.beforeAll(async () => {
    electronApp = await electron.launch({ args: ["."] });
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
