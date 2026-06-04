import { BrowserWindow, screen } from "electron";
import { join, normalize } from "node:path";

import Emittery from "emittery";

import {
  captureNextWindowFirstCursorEnter,
  DesktopEnvironment,
  getCursorPosition,
  getDesktopEnvironment,
} from "@open-orpheus/window";

import { menuSkin, registerMenuSkinUpdater } from "./menu/skin";
import type { MenuClickHandler } from "./menu/types";
import { patchById } from "./menu/types";
import {
  createMenuWindow,
  createOverlayWindow,
  destroyMenuWindow,
  destroyOverlayWindow,
  getMenuWindow,
  getOverlayWindow,
} from "./menu/windows";
import packManager from "./pack";
import SkinPack from "./packs/SkinPack";
import { registerIpcHandlers } from "../bridge/register";
import type { MenuContract } from "../bridge/contracts/menu-api";
import { parseBtnUrl, parseElementTemplate } from "./skin/dui";
import type { ElementTemplate } from "./skin/dui";
import { registerInputRegionHandlers } from "../bridge/common/inputRegion";

import type { AppMenuItem } from "$sharedTypes/menu";

registerMenuSkinUpdater();

const WAYLAND_CURSOR_CAPTURE_DEADLINE_MS = 200;

/** Recursively parse btn.url → btn.images for every menu item. */
function parseButtonUrls(items: AppMenuItem[]) {
  for (const item of items) {
    if (item.btns) {
      for (const btn of item.btns) {
        btn.images = parseBtnUrl(btn.url);
      }
    }
    if (item.children) parseButtonUrls(item.children);
  }
}

export type AppMenuEvents = {
  close: undefined;
};

export default class AppMenu extends Emittery<AppMenuEvents> {
  private onClick: MenuClickHandler | null = null;
  private closed = false;
  private submenuWindow: BrowserWindow | null = null;
  /** style path → parsed template, preloaded from skin pack */
  templates: Record<string, ElementTemplate> = {};

  constructor(public items: AppMenuItem[]) {
    super();
    parseButtonUrls(this.items);
  }

  setClickHandler(handler: MenuClickHandler) {
    this.onClick = handler;
  }

  /** Collect all distinct style paths from items and load their XML from the skin pack. */
  async loadTemplates() {
    const styles = new Set<string>();
    function collect(list: AppMenuItem[]) {
      for (const item of list) {
        if (item.style) styles.add(item.style);
        if (item.children) collect(item.children);
      }
    }
    collect(this.items);

    if (styles.size === 0) return;

    const skinPack = await packManager.getOrWaitPack<SkinPack>("skin");
    const entries = await Promise.all(
      [...styles].map(async (style) => {
        try {
          const buf = await skinPack.readFile(normalize(`/${style}`));
          return [style, buf.toString("utf-8")] as const;
        } catch {
          return null;
        }
      })
    );

    this.templates = {};
    for (const entry of entries) {
      if (entry) {
        const tpl = parseElementTemplate(entry[1]);
        if (tpl) this.templates[entry[0]] = tpl;
      }
    }
  }

  async show() {
    this.closed = false;
    await this.loadTemplates();

    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      this.showOverlay();
    } else {
      this.showWindow();
    }
  }

  close() {
    this.closed = true;

    if (this.submenuWindow && !this.submenuWindow.isDestroyed()) {
      this.submenuWindow.destroy();
      this.submenuWindow = null;
    }

    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      destroyOverlayWindow();
    } else {
      destroyMenuWindow();
    }
    this.emit("close");
  }

  update(patchItems: AppMenuItem[]) {
    parseButtonUrls(patchItems);
    for (const patch of patchItems) {
      if (patch.menu_id == null) continue;
      patchById(this.items, patch);
    }

    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      const overlayWindow = getOverlayWindow();
      if (
        overlayWindow &&
        !overlayWindow.isDestroyed() &&
        overlayWindow.isVisible()
      ) {
        overlayWindow.webContents.send("menu.update", this.items);
      }
      return;
    }

    const menuWindow = getMenuWindow();
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      menuWindow.webContents.send("menu.update", this.items);
    }
  }

  // --- Wayland: fullscreen transparent overlay ---
  // Created fresh each time so the compositor sends pointer-enter,
  // which the renderer uses to capture the real cursor position.
  private showOverlay() {
    const cursorPosition = new Promise<{ cursorX: number; cursorY: number }>(
      (resolve) => {
        let settled = false;
        const finish = (cursorX = 0, cursorY = 0) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ cursorX, cursorY });
        };

        const deadline = setTimeout(
          () => finish(),
          WAYLAND_CURSOR_CAPTURE_DEADLINE_MS
        );

        try {
          captureNextWindowFirstCursorEnter((cursorX, cursorY) => {
            finish(cursorX, cursorY);
          });
        } catch {
          finish();
          return;
        }
      }
    );

    const wnd = createOverlayWindow();

    const dismiss = () => {
      if (this.closed) return;
      this.close();
    };

    wnd.on("blur", () => {
      dismiss();
    });

    registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
      // Pull-based: the renderer calls menu.pull once SvelteKit has mounted.
      // We show the window here, then wait for the native first-enter capture
      // (or a short timeout fallback) before returning the initial cursor anchor.
      pull: async () => {
        if (!this.closed && !wnd.isDestroyed()) {
          wnd.show();
        }
        const { cursorX, cursorY } = await cursorPosition;
        return {
          items: this.items,
          templates: this.templates,
          colors: menuSkin,
          cursorX,
          cursorY,
        };
      },
      itemClick: async (_event, menuId) => {
        this.onClick?.(menuId);
        dismiss();
      },
      btnClick: async (_event, btnId) => {
        this.onClick?.(btnId);
      },
      close: async () => {
        dismiss();
      },
      reportSize: async () => {},
      openSubmenu: async () => {},
      closeSubmenu: async () => {},
    });
    registerInputRegionHandlers(wnd);
  }

  // --- Non-Wayland: transparent popup BrowserWindow ---
  private showWindow() {
    const de = getDesktopEnvironment();

    const wnd = createMenuWindow();
    let cursor = screen.getCursorScreenPoint();
    if (de === DesktopEnvironment.X11) {
      const pos = getCursorPosition();
      if (pos) {
        cursor = screen.screenToDipPoint({
          x: pos[0],
          y: pos[1],
        });
      }
    }
    const display = screen.getDisplayNearestPoint(cursor);

    const closeSubmenuWindow = () => {
      if (this.submenuWindow && !this.submenuWindow.isDestroyed()) {
        this.submenuWindow.destroy();
        this.submenuWindow = null;
      }
    };

    const openSubmenuWindow = (
      items: unknown[],
      templates: Record<string, ElementTemplate>,
      relX: number,
      relY: number
    ) => {
      closeSubmenuWindow();
      const bounds = wnd.getBounds();
      const screenX = bounds.x + Math.round(relX);
      const screenY = bounds.y + Math.round(relY);
      const subDisplay = screen.getDisplayNearestPoint({
        x: screenX,
        y: screenY,
      });

      const sub = new BrowserWindow({
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: true,
        skipTaskbar: true,
        resizable: false,
        alwaysOnTop: true,
        focusable: true,
        webPreferences: {
          partition: "open-orpheus",
          preload: join(__dirname, "menu.js"),
          additionalArguments: ["--submenu"],
        },
      });
      this.submenuWindow = sub;

      if (GUI_VITE_DEV_SERVER_URL) {
        sub.loadURL(`${GUI_VITE_DEV_SERVER_URL}/menu`);
      } else {
        sub.loadURL("gui://frontend/menu");
      }

      sub.on("closed", () => {
        if (this.submenuWindow === sub) this.submenuWindow = null;
      });

      registerIpcHandlers<MenuContract>(sub.webContents, "menu", {
        pull: async () => {
          return { items, templates, colors: menuSkin };
        },
        itemClick: async (_event, menuId) => {
          this.onClick?.(menuId);
          this.close();
        },
        btnClick: async (_event, btnId) => {
          this.onClick?.(btnId);
        },
        reportSize: async (_event, width, height) => {
          if (sub.isDestroyed()) return;
          const { x: dx, y: dy, width: dw, height: dh } = subDisplay.workArea;
          let x = screenX;
          let y = screenY;
          if (x + width > dx + dw) x = bounds.x - Math.round(width);
          if (y + height > dy + dh) y = dy + dh - height;
          if (x < dx) x = dx;
          if (y < dy) y = dy;
          sub.setBounds({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
          });
          sub.showInactive();
        },
        close: async () => {},
        openSubmenu: async () => {},
        closeSubmenu: async () => {},
      });

      sub.on("blur", () => {
        setTimeout(() => {
          // If focus went back to the main menu, keep open
          if (!wnd.isDestroyed() && wnd.isFocused()) return;
          if (!this.closed) {
            this.close();
          }
        }, 100);
      });
    };

    registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
      // Pull-based bootstrap so renderer can always request data after mount.
      pull: async () => {
        return {
          items: this.items,
          templates: this.templates,
          colors: menuSkin,
        };
      },
      reportSize: async (_event, width, height) => {
        if (this.closed || wnd.isDestroyed()) return;
        const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
        const onBottomHalf = cursor.y > dy + dh / 2;
        let x = cursor.x;
        let y = onBottomHalf ? cursor.y - height : cursor.y;
        if (x + width > dx + dw) x = dx + dw - width;
        if (y + height > dy + dh) y = dy + dh - height;
        if (x < dx) x = dx;
        if (y < dy) y = dy;
        wnd.setBounds({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        });
        wnd.showInactive();
        wnd.focus();
      },
      itemClick: async (_event, menuId) => {
        this.onClick?.(menuId);
        this.close();
      },
      btnClick: async (_event, btnId) => {
        this.onClick?.(btnId);
      },
      close: async () => {
        this.close();
      },
      openSubmenu: async (_event, items, templates, relX, relY) => {
        openSubmenuWindow(items, templates, relX, relY);
      },
      closeSubmenu: async () => {
        closeSubmenuWindow();
      },
    });

    const blurCheck = () => {
      // If focus moved to the submenu window, keep the menu open
      if (
        this.submenuWindow &&
        !this.submenuWindow.isDestroyed() &&
        this.submenuWindow.isFocused()
      ) {
        return;
      }
      // If the main window regained focus (e.g. brief WM focus shuffle), keep open
      if (!wnd.isDestroyed() && wnd.isFocused()) {
        return;
      }
      if (!this.closed) {
        this.close();
      }
    };

    wnd.on("blur", () => {
      setTimeout(blurCheck, 100);
    });
  }
}
