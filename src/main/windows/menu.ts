import { BrowserWindow, screen } from "electron";
import { normalize } from "node:path";

import Emittery from "emittery";
import {
  cancelNextWindowFirstCursorEnter,
  cancelWindowPointerAxisCapture,
  captureNextWindowFirstCursorEnter,
  captureWindowNextPointerAxis,
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
  createSubmenuWindow,
  destroyMenuWindow,
  destroyOverlayWindow,
  getMenuWindow,
  getOverlayWindow,
} from "./menu/windows";
import packManager from "../services/pack";
import SkinPack from "../services/packs/SkinPack";
import { registerIpcHandlers } from "../../bridge/register";
import type { MenuContract } from "../../bridge/contracts/menu-api";
import { parseBtnUrl, parseElementTemplate } from "../domain/skin/dui";
import type { ElementTemplate } from "../domain/skin/dui";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import type { AppMenuItem } from "@shared/types/menu";
import { font } from "../platform/gui";
import { ManagedWindow } from "./managedWindow";
import { toError } from "@shared/util";
import { isLiveFocusedWindow, runMenuCallbacks, scheduleMenuTask } from "./menu/lifecycle";
import { overlayPolicy, workaroundEnabled, WorkaroundFlags } from "./menu/workaround";
import {
  armNativeWaylandPopupWhenReady,
  NATIVE_MENU_SHADOW_INSET,
  waitForWaylandPopup,
  waylandWindowId,
} from "./menu/native-popup";
import { initializeWaylandPopupSupport } from "./menu/popup-support";

registerMenuSkinUpdater();

const WAYLAND_CURSOR_CAPTURE_DEADLINE_MS = 200;
const MENU_RENDER_READY_TIMEOUT_MS = 10_000;
const MAX_MENU_DIMENSION = 8_192;

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

function normalizeMenuSize(rawWidth: number, rawHeight: number) {
  const width = Number.isFinite(rawWidth) ? rawWidth : 300;
  const height = Number.isFinite(rawHeight) ? rawHeight : 400;
  return {
    width: Math.min(MAX_MENU_DIMENSION, Math.max(1, Math.ceil(width))),
    height: Math.min(MAX_MENU_DIMENSION, Math.max(1, Math.ceil(height))),
  };
}

function normalizeMenuCoordinate(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_MENU_DIMENSION, Math.max(-MAX_MENU_DIMENSION, Math.round(value)));
}

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

let activeMenu: AppMenu | null = null;

function activateMenu(menu: AppMenu) {
  if (activeMenu === menu) return;
  activeMenu?.close();
  activeMenu = menu;
}

export default class AppMenu extends Emittery<AppMenuEvents> {
  private onClick: MenuClickHandler | null = null;
  private closed = false;
  private started = false;
  private showPromise: Promise<void> | null = null;
  private readonly lifetimeAbort = new AbortController();
  private submenuWindow: BrowserWindow | null = null;
  private submenuGeneration = 0;
  private submenuCleanups: Array<() => void> = [];
  private dismissCleanups: Array<() => void> = [];
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

    const skinPack = await packManager.getOrWaitPack<SkinPack>("skin", this.lifetimeAbort.signal);
    const entries = await waitWithAbort(
      Promise.all(
        [...styles].map(async (style) => {
          try {
            const buf = await skinPack.readFile(normalize(`/${style}`));
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
    const cancelOpeningDeadline = scheduleMenuTask(
      () => {
        if (!this.closed) this.close();
      },
      MENU_RENDER_READY_TIMEOUT_MS,
      this.dismissCleanups
    );
    try {
      await opening;
    } finally {
      cancelOpeningDeadline();
      if (this.showPromise === opening) this.showPromise = null;
    }
  }

  private async open(parentWindow?: BrowserWindow) {
    activateMenu(this);
    try {
      await this.loadTemplates();
    } catch (error) {
      if (this.closed && this.lifetimeAbort.signal.aborted) return;
      this.close();
      throw error;
    }

    if (this.closed) return;

    try {
      const desktopEnvironment = getDesktopEnvironment();
      if (desktopEnvironment === DesktopEnvironment.Wayland) {
        let supportsPopup = false;
        if (parentWindow) {
          try {
            supportsPopup = await waitWithAbort(
              initializeWaylandPopupSupport(parentWindow),
              this.lifetimeAbort.signal
            );
          } catch (error) {
            if (this.closed && this.lifetimeAbort.signal.aborted) return;
            LOGGER.warn({ err: toError(error) }, "Wayland popup availability check failed");
          }
        }
        if (this.closed) return;
        if (parentWindow && supportsPopup) {
          this.showWaylandPopup(parentWindow);
        } else {
          this.showOverlay();
        }
      } else {
        this.showWindow();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lifetimeAbort.abort();
    const ownsGlobalWindows = activeMenu === this;
    if (ownsGlobalWindows) activeMenu = null;
    this.closeSubmenuWindow();
    this.clearDismissResources();

    if (ownsGlobalWindows) {
      if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
        destroyMenuWindow();
        destroyOverlayWindow();
      } else {
        destroyMenuWindow();
      }
    }
    const closeEvent = this.emit("close");
    this.onClick = null;
    void closeEvent
      .catch((err) => LOGGER.warn({ err: toError(err) }, "Menu close listener failed"))
      .finally(() => this.clearListeners());
  }

  private clearDismissResources() {
    this.clearResources(this.dismissCleanups);
  }

  private clearResources(resources: Array<() => void>) {
    runMenuCallbacks(resources.splice(0), (err) => {
      LOGGER.warn({ err: toError(err) }, "Menu dismiss cleanup failed");
    });
  }

  private scheduleDismiss(resources: Array<() => void>, callback: () => void, delay: number) {
    if (this.closed) return;
    scheduleMenuTask(
      () => {
        if (!this.closed) callback();
      },
      delay,
      resources
    );
  }

  update(patchItems: AppMenuItem[]) {
    parseButtonUrls(patchItems);
    for (const patch of patchItems) {
      if (patch.menu_id == null) continue;
      patchById(this.items, patch);
    }

    if (this.closed || activeMenu !== this) return;

    if (getDesktopEnvironment() === DesktopEnvironment.Wayland) {
      const menuWindow = getMenuWindow();
      if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
        menuWindow.webContents.send("menu.update", this.items);
      }
      const overlayWindow = getOverlayWindow();
      if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
        overlayWindow.webContents.send("menu.update", this.items);
      }
      return;
    }

    const menuWindow = getMenuWindow();
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      menuWindow.webContents.send("menu.update", this.items);
    }
  }

  /**
   * Measure the existing Svelte menu while hidden, then map that same window
   * as a real xdg_popup through the Wayland proxy without loading it twice.
   */
  private showWaylandPopup(parentWindow: BrowserWindow) {
    let activePopup: BrowserWindow | null = null;
    let popupMapped = false;
    const dismiss = () => {
      if (!this.closed) this.close();
    };
    const fallbackToOverlay = (reason = "popup reservation unavailable", error?: unknown) => {
      if (this.closed) return;
      LOGGER.warn(
        { reason, ...(error === undefined ? {} : { err: toError(error) }) },
        "Wayland popup unavailable; falling back to overlay"
      );
      // Clear the identity first so destroying an unconverted toplevel cannot
      // make its `closed` handler close the whole menu.
      activePopup = null;
      this.clearDismissResources();
      destroyMenuWindow();
      if (this.closed) return;
      try {
        this.showOverlay();
      } catch (err) {
        LOGGER.warn({ err: toError(err) }, "Menu overlay fallback failed");
        this.close();
      }
    };
    try {
      const token = captureWindowNextPointerAxis(
        waylandWindowId(parentWindow, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
        () => {
          // Exceptions must not escape a native threadsafe-function callback.
          try {
            dismiss();
          } catch (err) {
            LOGGER.warn({ err: toError(err) }, "Menu axis dismissal failed");
          }
        }
      );
      this.dismissCleanups.push(() => cancelWindowPointerAxisCapture(token));
    } catch {
      // Keep the Electron event fallback below when the native hook is absent.
    }

    const dismissOnWheel = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (input.type === "mouseWheel") dismiss();
    };
    const dismissOnParentInput = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
      if (input.type === "mouseDown" || input.type === "mouseWheel") {
        dismiss();
      }
    };
    const dismissOnParentBlur = () => {
      this.scheduleDismiss(
        this.dismissCleanups,
        () => {
          if (activePopup && !activePopup.isDestroyed() && activePopup.isFocused()) return;
          if (isLiveFocusedWindow(this.submenuWindow)) return;
          dismiss();
        },
        50
      );
    };
    parentWindow.webContents.on("before-mouse-event", dismissOnParentInput);
    parentWindow.on("blur", dismissOnParentBlur);
    parentWindow.once("closed", dismiss);
    this.dismissCleanups.push(() => {
      parentWindow.off("closed", dismiss);
      if (!parentWindow.isDestroyed() && !parentWindow.webContents.isDestroyed()) {
        parentWindow.webContents.off("before-mouse-event", dismissOnParentInput);
      }
      parentWindow.off("blur", dismissOnParentBlur);
    });

    const openPopup = (width: number, height: number) => {
      if (this.closed) return;
      let popup: BrowserWindow | null = null;
      try {
        // Create and load the exact target first. The native "next toplevel"
        // reservation is armed only from its first size report, immediately
        // before showInactive() asks Chromium to create the Wayland role.
        popup = createMenuWindow(width, height);
        activePopup = popup;
        const showAsPopup = (actualWidth: number, actualHeight: number) => {
          width = actualWidth;
          height = actualHeight;
          popup?.setSize(width, height);
          const cancelArm = armNativeWaylandPopupWhenReady(
            waylandWindowId(parentWindow, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
            waylandWindowId(popup!, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
            width,
            height,
            undefined,
            () =>
              this.closed ||
              parentWindow.isDestroyed() ||
              popup?.isDestroyed() !== false ||
              activePopup !== popup,
            (disposePending) => {
              if (this.closed || !popup || popup.isDestroyed() || activePopup !== popup) {
                disposePending();
                return;
              }
              this.dismissCleanups.push(disposePending);
              try {
                popup.showInactive();
              } catch (err) {
                disposePending();
                fallbackToOverlay("popup show failed", err);
                return;
              }
              void waitForWaylandPopup(
                waylandWindowId(popup, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
                () => Boolean(this.closed || !popup || popup.isDestroyed() || activePopup !== popup)
              ).then(
                (converted) => {
                  disposePending();
                  if (this.closed || activePopup !== popup) return;
                  if (!converted) {
                    fallbackToOverlay("popup conversion timed out");
                    return;
                  }
                  if (!this.closed && popup && !popup.isDestroyed() && activePopup === popup) {
                    popupMapped = true;
                    popup.webContents.send("menu.popupReady");
                    popup.focus();
                  }
                },
                (err) => {
                  disposePending();
                  if (this.closed || activePopup !== popup) return;
                  fallbackToOverlay("popup conversion failed", err);
                }
              );
            },
            fallbackToOverlay
          );
          if (!this.closed && popup?.isDestroyed() === false && activePopup === popup) {
            this.dismissCleanups.push(cancelArm);
          } else {
            cancelArm();
          }
        };
        bindWindow(popup, showAsPopup);
        popup.webContents.on("before-mouse-event", dismissOnWheel);
        this.dismissCleanups.push(() => {
          if (popup && !popup.isDestroyed()) {
            popup.webContents.off("before-mouse-event", dismissOnWheel);
          }
        });
        popup.on("blur", () => {
          this.scheduleDismiss(
            this.dismissCleanups,
            () => {
              if (activePopup !== popup) return;
              if (isLiveFocusedWindow(this.submenuWindow)) return;
              dismiss();
            },
            100
          );
        });
        popup.on("closed", () => {
          if (activePopup !== popup) return;
          activePopup = null;
          if (!this.closed) dismiss();
        });
      } catch (err) {
        activePopup = null;
        if (popup && !popup.isDestroyed()) popup.destroy();
        fallbackToOverlay("popup initialization failed", err);
      }
    };

    const bindWindow = (
      wnd: BrowserWindow,
      showAsPopup: (width: number, height: number) => void
    ) => {
      let displayHandled = false;
      const cancelMeasurementDeadline = scheduleMenuTask(
        () => {
          if (!displayHandled && activePopup === wnd && !this.closed) dismiss();
        },
        MENU_RENDER_READY_TIMEOUT_MS,
        this.dismissCleanups
      );
      registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
        getFont: async () => font,
        pull: async () => ({
          items: this.items,
          templates: this.templates,
          colors: menuSkin,
          shadowInset: NATIVE_MENU_SHADOW_INSET,
          pendingPopup: !popupMapped,
        }),
        itemClick: async (_event, menuId) => {
          try {
            this.onClick?.(menuId);
          } finally {
            dismiss();
          }
        },
        btnClick: async (_event, btnId) => {
          this.onClick?.(btnId);
        },
        close: async () => dismiss(),
        reportSize: async (_event, rawWidth, rawHeight) => {
          if (this.closed || wnd.isDestroyed()) return;
          const size = normalizeMenuSize(rawWidth, rawHeight);
          const { width, height } = size;

          if (displayHandled || activePopup !== wnd) return;
          displayHandled = true;
          cancelMeasurementDeadline();
          try {
            showAsPopup(width, height);
          } catch (err) {
            fallbackToOverlay("popup arming failed", err);
          }
        },
        openSubmenu: async (_event, items, templates, x, y) => {
          if (displayHandled && activePopup === wnd && !this.closed) {
            this.openWaylandSubmenu(wnd, items, templates, x, y);
          }
        },
        closeSubmenu: async () => {
          if (activePopup === wnd) this.closeSubmenuWindow();
        },
      });
      registerInputRegionHandlers(wnd, ManagedWindow);
    };

    openPopup(300, 400);
  }

  private closeSubmenuWindow() {
    this.submenuGeneration++;
    this.clearResources(this.submenuCleanups);
    const submenuWindow = this.submenuWindow;
    this.submenuWindow = null;
    if (submenuWindow && !submenuWindow.isDestroyed()) submenuWindow.destroy();
  }

  private openWaylandSubmenu(
    parent: BrowserWindow,
    items: unknown[],
    templates: Record<string, ElementTemplate>,
    relX: number,
    relY: number
  ) {
    this.closeSubmenuWindow();
    if (this.closed || parent.isDestroyed()) return;
    let popup: BrowserWindow;
    try {
      popup = createSubmenuWindow();
    } catch (error) {
      LOGGER.warn({ err: toError(error) }, "Wayland submenu creation failed");
      return;
    }
    this.submenuWindow = popup;
    let popupMapped = false;
    const generation = this.submenuGeneration;
    const isCurrent = () =>
      !this.closed &&
      generation === this.submenuGeneration &&
      this.submenuWindow === popup &&
      !popup.isDestroyed() &&
      !parent.isDestroyed();
    const closeUnavailable = () => {
      if (generation === this.submenuGeneration) this.closeSubmenuWindow();
    };
    let displayHandled = false;
    const cancelMeasurementDeadline = scheduleMenuTask(
      closeUnavailable,
      MENU_RENDER_READY_TIMEOUT_MS,
      this.submenuCleanups
    );

    try {
      registerIpcHandlers<MenuContract>(popup.webContents, "menu", {
        getFont: async () => font,
        pull: async () => ({
          items,
          templates,
          colors: menuSkin,
          shadowInset: NATIVE_MENU_SHADOW_INSET,
          pendingPopup: !popupMapped,
        }),
        itemClick: async (_event, menuId) => {
          try {
            this.onClick?.(menuId);
          } finally {
            this.close();
          }
        },
        btnClick: async (_event, btnId) => this.onClick?.(btnId),
        close: async () => {
          if (isCurrent()) this.close();
        },
        reportSize: async (_event, rawWidth, rawHeight) => {
          if (!isCurrent() || displayHandled) return;
          displayHandled = true;
          cancelMeasurementDeadline();
          const { width, height } = normalizeMenuSize(rawWidth, rawHeight);
          try {
            // Keep the already-rendered window; only its native role is mapped.
            popup.setSize(width, height);
            const cancelArm = armNativeWaylandPopupWhenReady(
              waylandWindowId(parent, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
              waylandWindowId(popup, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
              width,
              height,
              {
                // DOM coordinates include the parent's shadow margin;
                // xdg_positioner anchors are relative to its window geometry.
                x: Math.max(0, normalizeMenuCoordinate(relX) - NATIVE_MENU_SHADOW_INSET - 1),
                y: Math.max(0, normalizeMenuCoordinate(relY) - NATIVE_MENU_SHADOW_INSET),
              },
              () => !isCurrent(),
              (disposePending) => {
                if (!isCurrent()) {
                  disposePending();
                  return;
                }
                this.submenuCleanups.push(disposePending);
                try {
                  popup.showInactive();
                } catch (error) {
                  LOGGER.warn({ err: toError(error) }, "Wayland submenu show failed");
                  disposePending();
                  closeUnavailable();
                  return;
                }
                void waitForWaylandPopup(
                  waylandWindowId(popup, (wnd) => ManagedWindow.fromBrowserWindow(wnd)),
                  () => !isCurrent()
                ).then(
                  (converted) => {
                    disposePending();
                    if (!converted) {
                      closeUnavailable();
                    } else if (isCurrent()) {
                      popupMapped = true;
                      popup.webContents.send("menu.popupReady");
                      popup.focus();
                    }
                  },
                  (error) => {
                    LOGGER.warn({ err: toError(error) }, "Wayland submenu conversion failed");
                    disposePending();
                    closeUnavailable();
                  }
                );
              },
              closeUnavailable
            );
            if (isCurrent()) this.submenuCleanups.push(cancelArm);
            else cancelArm();
          } catch (error) {
            LOGGER.warn({ err: toError(error) }, "Wayland submenu arming failed");
            closeUnavailable();
          }
        },
        openSubmenu: async () => {},
        closeSubmenu: async () => {},
      });
      const dismissOnWheel = (_event: Electron.Event, input: Electron.MouseInputEvent) => {
        if (input.type === "mouseWheel" && isCurrent()) this.close();
      };
      popup.webContents.on("before-mouse-event", dismissOnWheel);
      this.submenuCleanups.push(() => {
        if (!popup.isDestroyed()) popup.webContents.off("before-mouse-event", dismissOnWheel);
      });
      popup.on("closed", () => {
        if (this.submenuWindow !== popup) return;
        this.submenuWindow = null;
        this.submenuGeneration++;
        this.clearResources(this.submenuCleanups);
      });
      popup.on("blur", () => {
        this.scheduleDismiss(
          this.submenuCleanups,
          () => {
            if (!isCurrent() || parent.isFocused()) return;
            this.close();
          },
          100
        );
      });
    } catch (error) {
      LOGGER.warn({ err: toError(error) }, "Wayland submenu initialization failed");
      closeUnavailable();
    }
  }

  // --- Wayland: fullscreen transparent overlay ---
  // Created fresh each time so the compositor sends pointer-enter,
  // which the renderer uses to capture the real cursor position.
  private showOverlay() {
    // Even a forced fullscreen overlay can acquire its role at construction.
    const captureBeforeCreate =
      overlayPolicy.capturePhase === "before-create" ||
      !workaroundEnabled(WorkaroundFlags.OverlayNoFullscreen);
    let cancelCursorCapture = () => {};
    let finishCursorCapture = () => {};
    let startCursorCapture = () => {};
    const cursorPosition = new Promise<{ cursorX: number; cursorY: number }>((resolve) => {
      let settled = false;
      let started = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (cursorX = 0, cursorY = 0) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        cancelCursorCapture();
        resolve({ cursorX, cursorY });
      };
      finishCursorCapture = finish;
      startCursorCapture = () => {
        if (started || settled) return;
        started = true;
        deadline = setTimeout(() => finish(), WAYLAND_CURSOR_CAPTURE_DEADLINE_MS);
        try {
          const token = captureNextWindowFirstCursorEnter((cursorX, cursorY) => {
            runMenuCallbacks([() => finish(cursorX, cursorY)], (err) => {
              LOGGER.warn({ err: toError(err) }, "Menu cursor capture failed");
            });
          });
          cancelCursorCapture = () => {
            cancelNextWindowFirstCursorEnter(token);
          };
          // A native callback can settle synchronously during registration.
          if (settled) cancelCursorCapture();
        } catch {
          finish();
        }
      };
    });
    this.dismissCleanups.push(() => {
      finishCursorCapture();
    });

    // KDE (and legacy desktop paths) must observe surface creation, not wait
    // for renderer pull: the first enter can already have happened by then.
    if (captureBeforeCreate) startCursorCapture();
    const wnd = createOverlayWindow();
    let rendererReady = false;
    const cancelRendererDeadline = scheduleMenuTask(
      () => {
        if (!rendererReady && !this.closed) this.close();
      },
      MENU_RENDER_READY_TIMEOUT_MS,
      this.dismissCleanups
    );

    const dismiss = () => {
      if (this.closed) return;
      this.close();
    };

    wnd.on("blur", () => {
      dismiss();
    });
    wnd.on("closed", () => {
      dismiss();
    });

    registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
      getFont: async () => font,

      // Pull-based: the renderer calls menu.pull once SvelteKit has mounted.
      // We show the window here, then wait for the native first-enter capture
      // (or a short timeout fallback) before returning the initial cursor anchor.
      pull: async () => {
        rendererReady = true;
        cancelRendererDeadline();
        if (!this.closed && !wnd.isDestroyed()) {
          // Hidden GNOME/niri fallback overlays map on show; arm as late as
          // possible there without changing KDE's capture-before-create path.
          if (!captureBeforeCreate) startCursorCapture();
          wnd.show();
        } else {
          finishCursorCapture();
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
        try {
          this.onClick?.(menuId);
        } finally {
          dismiss();
        }
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
    registerInputRegionHandlers(wnd, ManagedWindow);
  }

  // --- Non-Wayland: transparent popup BrowserWindow ---
  private showWindow() {
    const de = getDesktopEnvironment();

    const wnd = createMenuWindow();
    let rendererReady = false;
    const cancelRendererDeadline = scheduleMenuTask(
      () => {
        if (!rendererReady && !this.closed) this.close();
      },
      MENU_RENDER_READY_TIMEOUT_MS,
      this.dismissCleanups
    );
    wnd.once("closed", () => {
      if (!this.closed) this.close();
    });
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

    const openSubmenuWindow = (
      items: unknown[],
      templates: Record<string, ElementTemplate>,
      relX: number,
      relY: number
    ) => {
      this.closeSubmenuWindow();
      const generation = this.submenuGeneration;
      const cancelRendererDeadline = scheduleMenuTask(
        () => {
          if (generation === this.submenuGeneration) this.closeSubmenuWindow();
        },
        MENU_RENDER_READY_TIMEOUT_MS,
        this.submenuCleanups
      );
      const bounds = wnd.getBounds();
      const screenX = bounds.x + normalizeMenuCoordinate(relX);
      const screenY = bounds.y + normalizeMenuCoordinate(relY);
      const subDisplay = screen.getDisplayNearestPoint({
        x: screenX,
        y: screenY,
      });

      let createdSubmenu: BrowserWindow | null = null;
      try {
        const sub = createSubmenuWindow();
        createdSubmenu = sub;
        this.submenuWindow = sub;

        sub.on("closed", () => {
          if (this.submenuWindow !== sub) return;
          this.submenuWindow = null;
          this.submenuGeneration++;
          this.clearResources(this.submenuCleanups);
        });

        registerIpcHandlers<MenuContract>(sub.webContents, "menu", {
          getFont: async () => font,
          pull: async () => {
            return { items, templates, colors: menuSkin };
          },
          itemClick: async (_event, menuId) => {
            try {
              this.onClick?.(menuId);
            } finally {
              this.close();
            }
          },
          btnClick: async (_event, btnId) => {
            this.onClick?.(btnId);
          },
          reportSize: async (_event, width, height) => {
            if (sub.isDestroyed()) return;
            cancelRendererDeadline();
            const size = normalizeMenuSize(width, height);
            ({ width, height } = size);
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
          this.scheduleDismiss(
            this.submenuCleanups,
            () => {
              if (generation !== this.submenuGeneration) return;
              // If focus went back to the main menu, keep open.
              if (isLiveFocusedWindow(wnd)) return;
              this.close();
            },
            100
          );
        });
      } catch {
        if (createdSubmenu && !createdSubmenu.isDestroyed()) {
          createdSubmenu.destroy();
        }
        if (generation === this.submenuGeneration) {
          this.closeSubmenuWindow();
        }
      }
    };

    registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
      getFont: async () => font,
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
        rendererReady = true;
        cancelRendererDeadline();
        const size = normalizeMenuSize(width, height);
        ({ width, height } = size);
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
        try {
          this.onClick?.(menuId);
        } finally {
          this.close();
        }
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
        this.closeSubmenuWindow();
      },
    });

    const blurCheck = () => {
      // If focus moved to the submenu window, keep the menu open
      const submenuWnd = this.submenuWindow;
      if (submenuWnd && !submenuWnd.isDestroyed() && submenuWnd.isFocused()) {
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
      this.scheduleDismiss(this.dismissCleanups, blurCheck, 100);
    });
  }
}
