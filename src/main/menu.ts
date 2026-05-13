import {
  BrowserWindow,
  screen,
  Menu,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { join, normalize } from "node:path";
import { Resvg } from "@resvg/resvg-js";

import {
  captureNextWindowFirstCursorEnter,
  isWayland,
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
import { setMenu as setTrayMenu, useGnomeNativeMenu } from "./tray";
import packManager from "./pack";

import SkinPack from "./packs/SkinPack";
import { registerIpcHandlers } from "../bridge/register";
import type { MenuContract } from "../bridge/contracts/menu-api";
import { parseBtnUrl, parseElementTemplate } from "./skin/dui";
import type { ElementTemplate } from "./skin/dui";

import type { AppMenuItem, AppMenuItemBtn } from "$sharedTypes/menu";

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

export default class AppMenu extends EventTarget {
  private onClick: MenuClickHandler | null = null;
  private closed = false;
  private submenuWindow: BrowserWindow | null = null;
  /** style path → parsed template, preloaded from skin pack */
  templates: Record<string, ElementTemplate> = {};
  /** icon key → NativeImage */
  private loadedIcons: Record<string, NativeImage> = {};

  constructor(public items: AppMenuItem[]) {
    super();
    parseButtonUrls(this.items);
  }

  setClickHandler(handler: MenuClickHandler) {
    this.onClick = handler;
  }

  private btnLabel(btn: AppMenuItemBtn): string {
    const id = btn.id.toLowerCase();

    if (id.includes("prev")) return "上一首";
    if (id.includes("next")) return "下一首";
    if (id.includes("play")) return "播放";
    if (id.includes("pause")) return "暂停";
    if (id.includes("stop")) return "停止";
    if (id.includes("volume") || id.includes("vol")) return "音量";
    if (id.includes("like") || id.includes("heart")) return "喜欢";
    if (id.includes("favour") || id.includes("favorite")) return "收藏";
    if (id.includes("list") || id.includes("playlist")) return "播放列表";
    if (id.includes("shuffle")) return "随机播放";
    if (id.includes("repeat")) return "循环播放";
    if (id.includes("mode")) return "播放模式";
    return btn.id;
  }

  private itemLabel(item: AppMenuItem): string {
    return item.text || "";
  }

  private async getIcon(item: AppMenuItem | AppMenuItemBtn): Promise<NativeImage | undefined> {
    const skinPack = packManager.packs.get("skin2")?.isLoaded
      ? packManager.getPack<SkinPack>("skin2")
      : await packManager.getOrWaitPack<SkinPack>("skin");

    let iconPath: string | undefined;

    if ("id" in item) {
      // It's a button
      const id = item.id.toLowerCase();
      if (id.includes("prev")) iconPath = "/btn/previous.svg";
      else if (id.includes("next")) iconPath = "/btn/next.svg";
      else if (id.includes("play")) iconPath = "/btn/toplay.svg";
      else if (id.includes("pause")) iconPath = "/btn/topause.svg";
      else if (id.includes("like")) iconPath = "/btn/love.svg";
      else if (id.includes("loved")) iconPath = "/btn/loved.svg";
      else if (id.includes("list")) iconPath = "/btn/showlist.svg";
    } else {
      // It's a menu item
      const text = item.text || "";
      const path = item.image_path?.toLowerCase() || "";
      if (path.includes("home") || text.includes("首页")) iconPath = "/lrc/home_normal.svg";
      else if (path.includes("setting") || text.includes("设置")) iconPath = "/lrc/setting_normal.svg";
      else if (path.includes("exit") || text.includes("退出") || text.includes("关闭")) iconPath = "/lrc/close_normal.svg";
      else if (text.includes("歌词")) iconPath = "/mini/shunwang/icon24_lyric_n.png";
      else if (item.style === "song" || text.includes("正在播放")) iconPath = "/mini/shunwang/logo.png";
      else if (text.includes("列表")) iconPath = "/btn/showlist.svg";
      else if (text.includes("模式") || text.includes("完整")) iconPath = "/btn/toweb.svg";
    }

    if (!iconPath) return undefined;
    if (this.loadedIcons[iconPath]) return this.loadedIcons[iconPath];

    try {
      const buf = await skinPack.readFile(normalize(iconPath));
      let img: NativeImage;
      if (iconPath.endsWith(".svg")) {
        // Color SVG according to system theme, then rasterize to PNG
        let svgStr = buf.toString("utf-8");
        const color = nativeTheme.shouldUseDarkColors ? "#ffffff" : "#1e1e1e";
        if (!svgStr.includes("fill=")) {
          svgStr = svgStr.replace(/<path/g, `<path fill="${color}"`);
        } else {
          svgStr = svgStr.replace(/fill="[^"]*"/g, `fill="${color}"`);
        }
        const resvg = new Resvg(svgStr, {
          fitTo: { mode: "width", value: 36 },
        });
        const pngData = resvg.render();
        img = nativeImage.createFromBuffer(pngData.asPng(), { width: 18, height: 18 });
      } else {
        img = nativeImage.createFromBuffer(buf).resize({ width: 18, height: 18 });
      }
      this.loadedIcons[iconPath] = img;
      return img;
    } catch {
      return undefined;
    }
  }

  private async buildNativeMenuTemplate(
    items: AppMenuItem[]
  ): Promise<MenuItemConstructorOptions[]> {
    const result: MenuItemConstructorOptions[] = [];

    for (const item of items) {
      if (item.separator) {
        result.push({ type: "separator" });
        continue;
      }

      const icon = await this.getIcon(item);

      // Styled items with btns (e.g. playback controls)
      if (item.style && item.btns?.length) {
        const btnItems: MenuItemConstructorOptions[] = [];
        for (const btn of item.btns) {
          if (btn.enable !== false && btn.images) {
            btnItems.push({
              label: this.btnLabel(btn),
              icon: await this.getIcon(btn),
              click: () => {
                this.onClick?.(btn.id);
              },
            });
          }
        }
        if (btnItems.length > 0) {
          result.push(...btnItems);
        }
        continue;
      }

      result.push({
        label: this.itemLabel(item),
        icon,
        enabled: item.enable !== false,
        submenu: item.children
          ? await this.buildNativeMenuTemplate(item.children)
          : undefined,
        click: item.menu_id
          ? () => {
            this.onClick?.(item.menu_id!);
          }
          : undefined,
        accelerator: item.hotkey,
      });
    }

    return result;
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
    this.loadedIcons = {}; // Clear icon cache to support skin updates

    const isGnome = useGnomeNativeMenu();
    console.log(`[menu.show] isGnome=${isGnome}, items=${this.items.length}`);
    if (isGnome) {
      const template = await this.buildNativeMenuTemplate(this.items);
      console.log(`[menu.show] built native template, ${template.length} entries`);
      const nativeMenu = Menu.buildFromTemplate(template);

      // Update the tray's context menu via the proper tray module function.
      // A placeholder menu was already set at tray install time, which established
      // the AppIndicator D-Bus menu channel. This update replaces the placeholder
      // (or previous menu) so the next tray click shows the correct items.
      setTrayMenu(nativeMenu);
      console.log("[menu.show] setTrayMenu done");
      return;
    }

    await this.loadTemplates();

    if (process.platform === "linux" && isWayland()) {
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

    const isGnome = useGnomeNativeMenu();
    if (isGnome) {
      this.dispatchEvent(new Event("close"));
      return;
    }

    if (process.platform === "linux" && isWayland()) {
      destroyOverlayWindow();
    } else {
      destroyMenuWindow();
    }
    this.dispatchEvent(new Event("close"));
  }

  update(patchItems: AppMenuItem[]) {
    parseButtonUrls(patchItems);
    for (const patch of patchItems) {
      if (patch.menu_id == null) continue;
      patchById(this.items, patch);
    }

    const isGnome = useGnomeNativeMenu();
    if (isGnome) {
      this.loadedIcons = {}; // Clear cache for update
      (async () => {
        const template = await this.buildNativeMenuTemplate(this.items);
        const nativeMenu = Menu.buildFromTemplate(template);
        setTrayMenu(nativeMenu);
      })();
      return;
    }

    if (process.platform === "linux" && isWayland()) {
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
      reportSize: async () => { },
      openSubmenu: async () => { },
      closeSubmenu: async () => { },
    });
  }

  // --- Non-Wayland: transparent popup BrowserWindow ---
  private showWindow() {
    const wnd = createMenuWindow();
    const cursor = screen.getCursorScreenPoint();
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
        close: async () => { },
        openSubmenu: async () => { },
        closeSubmenu: async () => { },
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
