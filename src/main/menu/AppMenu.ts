import type { BrowserWindow } from "electron";
import Emittery from "emittery";
import {
  cancelWindowTouch,
  captureWindowTouch,
  DesktopEnvironment,
  getDesktopEnvironment,
  getPopupCapability,
} from "@open-orpheus/window";
import { ManagedWindow } from "../window";

import type { AppMenuItem } from "@shared/types/menu";
import { toError } from "@shared/util";
import { parseBtnUrl, parseElementTemplate } from "../skin/dui";
import type { ElementTemplate } from "../skin/dui";
import packManager from "../pack";
import SkinPack from "../packs/SkinPack";
import { menuSkin, registerMenuSkinUpdater } from "./skin";
import { selectAnchorCandidate } from "./anchor";
import { patchById } from "./patch";
import { PARENT_BLUR_DISMISS_MS } from "./constants";
import type { MenuBackend, MenuBackendContext } from "./backend/MenuBackend";
import { WaylandPopupBackend } from "./backend/WaylandPopupBackend";
import { WaylandOverlayBackend } from "./backend/WaylandOverlayBackend";
import { DesktopWindowBackend } from "./backend/DesktopWindowBackend";

registerMenuSkinUpdater();

export type AppMenuEvents = {
  close: undefined;
};

let activeMenu: AppMenu | null = null;

function activateMenu(menu: AppMenu) {
  if (activeMenu === menu) return;
  activeMenu?.close();
  activeMenu = menu;
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

type MenuClickHandler = (menuId: string | null) => void;

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

const MENU_SHADOW_INSET = 24;

export default class AppMenu extends Emittery<AppMenuEvents> {
  private onClick: MenuClickHandler | null = null;
  private closed = false;
  private started = false;
  private showPromise: Promise<void> | null = null;
  private readonly lifetimeAbort = new AbortController();
  private backend: MenuBackend | null = null;
  private context: MenuBackendContext | null = null;
  private readonly parentCleanups: Array<() => void> = [];
  private parentDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private parentTouchToken: number | null = null;
  /** style path → parsed template, preloaded from skin pack */
  templates: Record<string, ElementTemplate> = {};

  constructor(public items: AppMenuItem[]) {
    super();
    parseButtonUrls(this.items);
  }

  setClickHandler(handler: MenuClickHandler) {
    if (this.closed) return;
    this.onClick = handler;
  }

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

    const skinPack = await packManager.getOrWaitPack<SkinPack>("skin", this.lifetimeAbort.signal);
    const entries = await waitWithAbort(
      Promise.all(
        [...styles].map(async (style) => {
          try {
            const buf = await skinPack.readFile(`/${style.replaceAll("\\", "/")}`);
            return [style, buf.toString("utf-8")] as const;
          } catch {
            return null;
          }
        })
      ),
      this.lifetimeAbort.signal
    );

    if (this.closed || this.lifetimeAbort.signal.aborted) return;
    this.templates = {};
    for (const entry of entries) {
      if (entry) {
        const tpl = parseElementTemplate(entry[1]);
        if (tpl) this.templates[entry[0]] = tpl;
      }
    }
    LOGGER.debug(
      { templateCount: Object.keys(this.templates).length, styleCount: styles.size },
      "Menu templates loaded"
    );
  }

  async show(parentWindow?: BrowserWindow) {
    if (this.showPromise) {
      await this.showPromise;
      return;
    }
    if (this.started || this.closed) return;
    this.started = true;

    const opening = this.open(parentWindow);
    this.showPromise = opening;
    try {
      await opening;
    } finally {
      if (this.showPromise === opening) this.showPromise = null;
    }
  }

  private async open(parentWindow?: BrowserWindow) {
    activateMenu(this);
    const candidate = selectAnchorCandidate();
    const effectiveParent = candidate?.window ?? parentWindow;
    const anchor = candidate ? { x: candidate.x, y: candidate.y } : null;
    if (effectiveParent) this.watchParent(effectiveParent);
    try {
      await this.loadTemplates();
    } catch (error) {
      if (this.closed && this.lifetimeAbort.signal.aborted) return;
      this.close();
      throw error;
    }
    if (this.closed) return;

    const context: MenuBackendContext = {
      items: this.items,
      templates: this.templates,
      colors: menuSkin,
      parentWindow: effectiveParent,
      shadowInset: MENU_SHADOW_INSET,
      anchor,
      onItemClick: (menuId) => {
        try {
          this.onClick?.(menuId);
        } finally {
          this.close();
        }
      },
      onButtonClick: (btnId) => this.onClick?.(btnId),
      onClose: () => this.close(),
    };
    this.context = context;

    const backend = await this.selectBackend(context);
    this.backend = backend;

    try {
      await backend.open();
      LOGGER.info({ itemCount: this.items.length }, "Menu opened");
    } catch (error) {
      await backend.close();
      this.backend = null;
      if (this.closed) return;

      if (backend instanceof WaylandPopupBackend) {
        LOGGER.warn({ err: toError(error) }, "Wayland popup unavailable; falling back to overlay");
        const overlay = new WaylandOverlayBackend(context);
        this.backend = overlay;
        try {
          await overlay.open();
        } catch (error) {
          this.close();
          throw error;
        }
        LOGGER.info({ itemCount: this.items.length }, "Menu opened");
        return;
      }
      this.close();
      throw error;
    }
  }

  private watchParent(parent: BrowserWindow): void {
    if (parent.isDestroyed()) return;
    const dismissOnBlur = () => {
      if (this.closed) return;
      this.scheduleParentDismiss(parent);
    };
    // Parent input is explicit dismissal; unlike blur, do not check focus.
    const dismissOnInput = (_event: Electron.Event, event: Electron.MouseInputEvent) => {
      if (event.type === "mouseDown" || event.type === "mouseWheel") this.close();
    };
    const closed = () => this.close();

    parent.on("blur", dismissOnBlur);
    parent.once("closed", closed);
    parent.webContents.on("before-mouse-event", dismissOnInput);

    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      const managed = ManagedWindow.fromBrowserWindow(parent);
      if (managed) {
        try {
          this.parentTouchToken = captureWindowTouch(managed.id, () => {
            this.parentTouchToken = null;
            this.close();
          });
        } catch {
          // Native touch capture is optional.
        }
      }
    }
    this.parentCleanups.push(() => {
      parent.off("blur", dismissOnBlur);
      parent.off("closed", closed);
      if (!parent.isDestroyed() && !parent.webContents.isDestroyed()) {
        parent.webContents.off("before-mouse-event", dismissOnInput);
      }
    });
  }

  private scheduleParentDismiss(parent: BrowserWindow, retry = false): void {
    if (this.parentDismissTimer !== null) clearTimeout(this.parentDismissTimer);
    this.parentDismissTimer = setTimeout(
      () => {
        this.parentDismissTimer = null;
        const parentFocused = !parent.isDestroyed() && parent.isFocused();
        const backendFocused = this.backend?.isFocused() ?? false;
        const hasChildren = this.backend?.hasChildren() ?? false;
        if (this.closed) return;
        if (parentFocused) return;
        if (backendFocused) return;
        // Opening a submenu moves focus away from the parent menu; don't let
        // that parent blur tear the whole menu down.
        if (hasChildren && !retry) {
          this.scheduleParentDismiss(parent, true);
          return;
        }
        this.close();
      },
      retry ? 300 : PARENT_BLUR_DISMISS_MS
    );
  }

  private clearParentWatch(): void {
    if (this.parentDismissTimer !== null) {
      clearTimeout(this.parentDismissTimer);
      this.parentDismissTimer = null;
    }
    if (this.parentTouchToken !== null) {
      cancelWindowTouch(this.parentTouchToken);
      this.parentTouchToken = null;
    }
    for (const cleanup of this.parentCleanups.splice(0)) cleanup();
  }

  private async selectBackend(context: MenuBackendContext): Promise<MenuBackend> {
    const desktop = getDesktopEnvironment();
    if (desktop !== DesktopEnvironment.Wayland) {
      return new DesktopWindowBackend(context);
    }

    const parent = context.parentWindow;
    const capability = getPopupCapability();
    const usePopup = Boolean(
      parent && !parent.isDestroyed() && capability.supported && context.anchor
    );
    if (usePopup) return new WaylandPopupBackend(context);
    return new WaylandOverlayBackend(context);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetimeAbort.abort();
    this.clearParentWatch();
    const ownsGlobalWindows = activeMenu === this;
    if (ownsGlobalWindows) activeMenu = null;

    void this.backend?.close();
    this.backend = null;

    const closeEvent = this.emit("close");
    this.onClick = null;
    void closeEvent
      .catch((err) => LOGGER.warn({ err: toError(err) }, "Menu close listener failed"))
      .finally(() => this.clearListeners());
  }

  update(patchItems: AppMenuItem[]) {
    parseButtonUrls(patchItems);
    for (const patch of patchItems) {
      if (patch.menu_id == null) continue;
      patchById(this.items, patch);
    }

    if (this.closed || activeMenu !== this) return;
    this.backend?.update({ items: this.items, patches: patchItems });
  }
}
