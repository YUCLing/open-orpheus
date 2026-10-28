import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const dataDir = process.env["CUSTOM_DATA_DIR"]!;

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

  test.describe("login", () => {
    test.fixme();
    let loginWindow: Page;

    enum LoginMode {
      Qr,
      SMS,
      Password,
      Unknown,
    }

    async function determineCurrentLoginMode(): Promise<LoginMode> {
      // Make sure everything's stable
      await loginWindow.waitForSelector("[data-log*=page_pc_login]");
      const passwordInputAvailable = await loginWindow
        .getByTestId("tid_input_pc_login_password")
        .count();
      if (passwordInputAvailable) return LoginMode.Password;
      const phoneInputAvailable = await loginWindow.getByTestId("tid_input_pc_login_phone").count();
      if (phoneInputAvailable) return LoginMode.SMS;
      const qrCodeAvailable = await loginWindow.locator("//canvas").count();
      if (qrCodeAvailable) return LoginMode.Qr;
      return LoginMode.Unknown;
    }

    async function switchLoginMode(targetMode: LoginMode): Promise<void> {
      if (targetMode === LoginMode.Unknown) throw new Error("Cannot switch to Unknown login mode");
      const current = await determineCurrentLoginMode();
      if (current === LoginMode.Unknown) throw new Error("Unable to determine current login mode");
      if (current === targetMode) return;
      if (current === LoginMode.Qr) {
        await loginWindow.getByText("选择其它登录模式").click();
        if (targetMode === LoginMode.Password) {
          await loginWindow.getByText("密码登录").click();
        }
        return;
      }
      if (targetMode === LoginMode.Qr) {
        await loginWindow.locator("[data-log*=btn_pc_login_qr_code]").click();
      } else {
        if (targetMode === LoginMode.Password) {
          await loginWindow.getByText("密码登录").click();
        } else if (targetMode === LoginMode.SMS) {
          await loginWindow.getByText("验证码登录").click();
        }
      }
    }

    test("can open login window", async () => {
      // Nested
      await mainWindow
        .getByTestId("tid_pc_nav_bar_account")
        .first()
        .getByTestId("tid_pc_nav_bar_account")
        .click();
      loginWindow = await electronApp.waitForEvent("window");
      await loginWindow.getByTestId("tid_login_header").isVisible();
    });

    test("qr login shows code", async () => {
      await switchLoginMode(LoginMode.Qr);
      await expect(loginWindow.locator("css=canvas")).toBeVisible();
      //await loginWindow.locator("css=canvas").screenshot({ path: "qr.png" });
    });

    test("can type in phone number", async () => {
      await switchLoginMode(LoginMode.SMS);
      const phoneNumber = "13333333333";
      const phoneInput = loginWindow.getByTestId("tid_input_pc_login_phone");
      await phoneInput.fill(phoneNumber);
      await expect(phoneInput).toHaveValue(phoneNumber);
    });

    test("can type in password", async () => {
      await switchLoginMode(LoginMode.Password);
      const password = randomBytes(4).toString("hex");
      const passInput = loginWindow.getByTestId("tid_input_pc_login_password");
      await passInput.fill(password);
      await expect(passInput).toHaveValue(password);
    });

    test("can close login window", async () => {
      await loginWindow.getByTestId("tid_login_close_btn").click();
      await loginWindow.waitForEvent("close");
    });
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

  test.describe("play control", () => {
    test.fixme();

    test("can open vinyl page", async () => {
      await mainWindow.getByTestId("tid_btn_pc_minibar_vinyl").click();
    });

    test("can pause & play", async () => {
      const controlArea = mainWindow.locator("#vinyl-page-container");
      await controlArea.getByTestId("tid_playbar_play_btn").click();
    });

    test("can change volume", async () => {
      await mainWindow
        .locator("#vinyl-page-container")
        .getByTestId("tid_playbar_volume_btn")
        .hover();
      await expect(mainWindow.getByLabel("音量调节")).toBeAttached();
    });

    test("can load display mode", async () => {
      await mainWindow.getByTestId("tid_displaymode_entry_btn").click();
      const effectContainer = mainWindow
        .locator("#effect-wrapper")
        .getByTestId("tid_scroll_container");
      await expect(effectContainer.getByText("经典黑胶")).toBeAttached();
      // Changing requires login
      await mainWindow.mouse.click(0, 0);
      await mainWindow.getByTestId("tid_vinyl_unfold_btn").click();
    });
  });

  test.describe("album page", () => {
    test.fixme();

    test("can enter album page", async () => {
      await mainWindow
        .getByTestId("tid_searchresults_content")
        .locator("[data-log*=cell_pc_common_album]")
        .first()
        .click();
      await expect(mainWindow.getByText("专辑详情")).toBeAttached();
    });
  });
});
