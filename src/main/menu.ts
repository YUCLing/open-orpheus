import { BrowserWindow, screen } from "electron";
import { normalize } from "node:path";

import Emittery from "emittery";
import {
  armNextWindowAsPopup,
  cancelNextWindowFirstCursorEnter,
  cancelPendingPopup,
  cancelWindowPointerAxisCapture,
  captureNextWindowFirstCursorEnter,
  captureWindowNextPointerAxis,
  DesktopEnvironment,
  getCursorPosition,
  getDesktopEnvironment,
  isWindowWaylandPopup,
  supportsGnomeWaylandPopup,
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
import packManager from "./pack";
import SkinPack from "./packs/SkinPack";
import { registerIpcHandlers } from "../bridge/register";
import type { MenuContract } from "../bridge/contracts/menu-api";
import { parseBtnUrl, parseElementTemplate } from "./skin/dui";
import type { ElementTemplate } from "./skin/dui";
import { registerInputRegionHandlers } from "../bridge/common/inputRegion";
import type { AppMenuItem } from "$sharedTypes/menu";
import { font } from "./gui";

registerMenuSkinUpdater();

const WAYLAND_CURSOR_CAPTURE_DEADLINE_MS = 200;
const WAYLAND_POPUP_ID_WAIT_MS = 200;
const WAYLAND_POPUP_ID_RETRY_MS = 5;
const WAYLAND_POPUP_ARM_EXPIRY_MS = 5_000;
const MENU_RENDER_READY_TIMEOUT_MS = 10_000;
const MAX_MENU_DIMENSION = 8_192;

function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
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
  return Math.min(
    MAX_MENU_DIMENSION,
    Math.max(-MAX_MENU_DIMENSION, Math.round(value))
  );
}

async function waitForWaylandPopup(
  windowId: string,
  isCancelled: () => boolean
) {
  const deadline = Date.now() + WAYLAND_POPUP_ID_WAIT_MS;
  while (!isCancelled()) {
    const isPopup = isWindowWaylandPopup(windowId);
    if (isPopup) return true;
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, WAYLAND_POPUP_ID_RETRY_MS)
    );
  }
  return false;
}

function armGnomeWaylandPopupWhenReady(
  parentWindowId: string,
  width: number,
  height: number,
  anchor: { x: number; y: number } | undefined,
  isCancelled: () => boolean,
  onArmed: (token: number, disposePending: () => void) => void,
  onUnavailable: () => void
) {
  const deadline = Date.now() + WAYLAND_POPUP_ID_WAIT_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const attempt = () => {
    if (cancelled || isCancelled()) {
      return;
    }
    const token = anchor
      ? armNextWindowAsPopup(parentWindowId, width, height, anchor.x, anchor.y)
      : armNextWindowAsPopup(parentWindowId, width, height);
    if (token !== null) {
      let pending = true;
      const expiryTimer = setTimeout(() => {
        if (!pending) return;
        pending = false;
        cancelPendingPopup(token);
        if (!cancelled && !isCancelled()) {
          onUnavailable();
        }
      }, WAYLAND_POPUP_ARM_EXPIRY_MS);
      const disposePending = () => {
        if (!pending) return;
        pending = false;
        clearTimeout(expiryTimer);
        cancelPendingPopup(token);
      };
      try {
        onArmed(token, disposePending);
      } catch (error) {
        disposePending();
        throw error;
      }
    } else if (Date.now() < deadline) {
      retryTimer = setTimeout(attempt, WAYLAND_POPUP_ID_RETRY_MS);
    } else {
      onUnavailable();
    }
  };
  attempt();
  return () => {
    cancelled = true;
    if (retryTimer) clearTimeout(retryTimer);
  };
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
  private submenuMeasureWindow: BrowserWindow | null = null;
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

    const skinPack = await packManager.getOrWaitPack<SkinPack>(
      "skin",
      this.lifetimeAbort.signal
    );
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
    const openingDeadline = setTimeout(() => {
      if (!this.closed) this.close();
    }, MENU_RENDER_READY_TIMEOUT_MS);
    try {
      await opening;
    } finally {
      clearTimeout(openingDeadline);
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
      const supportsPopup = supportsGnomeWaylandPopup();
      if (desktopEnvironment === DesktopEnvironment.Wayland) {
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
    void closeEvent.then(
      () => this.clearListeners(),
      () => this.clearListeners()
    );
  }

  private clearDismissResources() {
    for (const cleanup of this.dismissCleanups.splice(0)) cleanup();
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

  /**
   * Measure the existing Svelte menu in an unmapped window, then create the
   * visible BrowserWindow as a real xdg_popup through the Wayland proxy.
   */
  private showWaylandPopup(parentWindow: BrowserWindow) {
    let measurementHandled = false;
    let activePopup: BrowserWindow | null = null;
    const dismiss = () => {
      if (!this.closed) this.close();
    };
    const fallbackToOverlay = () => {
      if (this.closed) return;
      // Clear the identity first so destroying an unconverted toplevel cannot
      // make its `closed` handler close the whole menu.
      activePopup = null;
      this.clearDismissResources();
      destroyMenuWindow();
      if (this.closed) return;
      try {
        this.showOverlay();
      } catch {
        this.close();
      }
    };
    try {
      const token = captureWindowNextPointerAxis(
        parentWindow.id.toString(),
        () => dismiss()
      );
      this.dismissCleanups.push(() => cancelWindowPointerAxisCapture(token));
    } catch {
      // Keep the Electron event fallback below when the native hook is absent.
    }

    const dismissOnWheel = (
      _event: Electron.Event,
      input: Electron.MouseInputEvent
    ) => {
      if (input.type === "mouseWheel") dismiss();
    };
    const dismissOnParentInput = (
      _event: Electron.Event,
      input: Electron.MouseInputEvent
    ) => {
      if (input.type === "mouseDown" || input.type === "mouseWheel") {
        dismiss();
      }
    };
    const dismissOnParentBlur = () => {
      setTimeout(() => {
        if (
          activePopup &&
          !activePopup.isDestroyed() &&
          activePopup.isFocused()
        )
          return;
        if (this.submenuWindow?.isFocused()) return;
        dismiss();
      }, 50);
    };
    parentWindow.webContents.on("before-mouse-event", dismissOnParentInput);
    parentWindow.on("blur", dismissOnParentBlur);
    parentWindow.once("closed", dismiss);
    this.dismissCleanups.push(() => {
      parentWindow.off("closed", dismiss);
      if (!parentWindow.webContents.isDestroyed()) {
        parentWindow.webContents.off(
          "before-mouse-event",
          dismissOnParentInput
        );
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
        const showAsPopup = () => {
          const cancelArm = armGnomeWaylandPopupWhenReady(
            parentWindow.id.toString(),
            width,
            height,
            undefined,
            () =>
              this.closed ||
              parentWindow.isDestroyed() ||
              popup?.isDestroyed() !== false ||
              activePopup !== popup,
            (_token, disposePending) => {
              if (
                this.closed ||
                !popup ||
                popup.isDestroyed() ||
                activePopup !== popup
              ) {
                disposePending();
                return;
              }
              this.dismissCleanups.push(disposePending);
              try {
                popup.showInactive();
              } catch {
                disposePending();
                fallbackToOverlay();
                return;
              }
              void waitForWaylandPopup(popup.id.toString(), () =>
                Boolean(
                  this.closed ||
                  !popup ||
                  popup.isDestroyed() ||
                  activePopup !== popup
                )
              ).then(
                (converted) => {
                  disposePending();
                  if (!converted) {
                    fallbackToOverlay();
                    return;
                  }
                  if (
                    !this.closed &&
                    popup &&
                    !popup.isDestroyed() &&
                    activePopup === popup
                  ) {
                    popup.focus();
                  }
                },
                () => {
                  disposePending();
                  fallbackToOverlay();
                }
              );
            },
            fallbackToOverlay
          );
          if (
            !this.closed &&
            popup?.isDestroyed() === false &&
            activePopup === popup
          ) {
            this.dismissCleanups.push(cancelArm);
          } else {
            cancelArm();
          }
        };
        bindWindow(popup, false, showAsPopup);
        popup.webContents.on("before-mouse-event", dismissOnWheel);
        this.dismissCleanups.push(() => {
          if (popup && !popup.isDestroyed()) {
            popup.webContents.off("before-mouse-event", dismissOnWheel);
          }
        });
        popup.on("blur", () => {
          setTimeout(() => {
            if (this.submenuWindow?.isFocused()) return;
            dismiss();
          }, 100);
        });
        popup.on("closed", () => {
          if (activePopup !== popup) return;
          activePopup = null;
          if (!this.closed) dismiss();
        });
      } catch {
        activePopup = null;
        if (popup && !popup.isDestroyed()) popup.destroy();
        fallbackToOverlay();
      }
    };

    const bindWindow = (
      wnd: BrowserWindow,
      measuring: boolean,
      showAsPopup: () => void = () => {}
    ) => {
      let displayHandled = false;
      registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
        getFont: async () => font,
        pull: async () => ({
          items: this.items,
          templates: this.templates,
          colors: menuSkin,
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

          if (!measuring) {
            if (displayHandled) return;
            displayHandled = true;
            showAsPopup();
            return;
          }
          if (measurementHandled) return;
          measurementHandled = true;
          clearTimeout(measurementDeadline);
          wnd.destroy();
          openPopup(width, height);
        },
        openSubmenu: async (_event, items, templates, x, y) => {
          if (!measuring) {
            this.openWaylandSubmenu(wnd, items, templates, x, y);
          }
        },
        closeSubmenu: async () => {
          if (!measuring) this.closeSubmenuWindow();
        },
      });
      registerInputRegionHandlers(wnd);
    };

    const measureWindow = createMenuWindow();
    const measurementDeadline = setTimeout(() => {
      if (!measurementHandled && !this.closed) dismiss();
    }, MENU_RENDER_READY_TIMEOUT_MS);
    this.dismissCleanups.push(() => clearTimeout(measurementDeadline));
    measureWindow.on("closed", () => {
      if (!measurementHandled && !this.closed) dismiss();
    });
    bindWindow(measureWindow, true);
  }

  private closeSubmenuWindow() {
    this.submenuGeneration++;
    for (const cleanup of this.submenuCleanups.splice(0)) cleanup();
    const measureWindow = this.submenuMeasureWindow;
    this.submenuMeasureWindow = null;
    if (measureWindow && !measureWindow.isDestroyed()) measureWindow.destroy();
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
    let measure: BrowserWindow;
    try {
      measure = createSubmenuWindow();
    } catch {
      return;
    }
    this.submenuMeasureWindow = measure;
    const generation = this.submenuGeneration;
    let measurementHandled = false;
    const measurementDeadline = setTimeout(() => {
      if (generation === this.submenuGeneration) this.closeSubmenuWindow();
    }, MENU_RENDER_READY_TIMEOUT_MS);
    this.submenuCleanups.push(() => clearTimeout(measurementDeadline));
    measure.on("closed", () => {
      if (this.submenuMeasureWindow !== measure) return;
      this.submenuMeasureWindow = null;
      this.submenuGeneration++;
      for (const cleanup of this.submenuCleanups.splice(0)) cleanup();
    });

    const bind = (
      wnd: BrowserWindow,
      measuring: boolean,
      showAsPopup: () => void = () => {}
    ) => {
      let displayHandled = false;
      registerIpcHandlers<MenuContract>(wnd.webContents, "menu", {
        getFont: async () => font,
        pull: async () => ({ items, templates, colors: menuSkin }),
        itemClick: async (_event, menuId) => {
          try {
            this.onClick?.(menuId);
          } finally {
            this.close();
          }
        },
        btnClick: async (_event, btnId) => this.onClick?.(btnId),
        close: async () => {},
        reportSize: async (_event, rawWidth, rawHeight) => {
          if (
            this.closed ||
            generation !== this.submenuGeneration ||
            wnd.isDestroyed()
          )
            return;
          const size = normalizeMenuSize(rawWidth, rawHeight);
          const { width, height } = size;
          if (!measuring) {
            if (displayHandled) return;
            displayHandled = true;
            showAsPopup();
            return;
          }
          if (measurementHandled) return;
          measurementHandled = true;
          clearTimeout(measurementDeadline);
          if (this.submenuMeasureWindow === wnd) {
            this.submenuMeasureWindow = null;
          }
          wnd.destroy();

          const anchorX = Math.max(0, normalizeMenuCoordinate(relX) - 1);
          const anchorY = Math.max(0, normalizeMenuCoordinate(relY));
          let popup: BrowserWindow | null = null;
          try {
            popup = createSubmenuWindow(width, height);
            this.submenuWindow = popup;
            const closeUnavailable = () => {
              if (generation === this.submenuGeneration) {
                this.closeSubmenuWindow();
              }
            };
            const showAsPopup = () => {
              const cancelArm = armGnomeWaylandPopupWhenReady(
                parent.id.toString(),
                width,
                height,
                { x: anchorX, y: anchorY },
                () =>
                  this.closed ||
                  generation !== this.submenuGeneration ||
                  parent.isDestroyed() ||
                  popup?.isDestroyed() !== false ||
                  this.submenuWindow !== popup,
                (_token, disposePending) => {
                  if (
                    this.closed ||
                    generation !== this.submenuGeneration ||
                    !popup ||
                    popup.isDestroyed() ||
                    this.submenuWindow !== popup
                  ) {
                    disposePending();
                    return;
                  }
                  this.submenuCleanups.push(disposePending);
                  try {
                    popup.showInactive();
                  } catch {
                    disposePending();
                    closeUnavailable();
                    return;
                  }
                  void waitForWaylandPopup(popup.id.toString(), () =>
                    Boolean(
                      this.closed ||
                      generation !== this.submenuGeneration ||
                      !popup ||
                      popup.isDestroyed() ||
                      this.submenuWindow !== popup
                    )
                  ).then(
                    (converted) => {
                      disposePending();
                      if (!converted) {
                        closeUnavailable();
                        return;
                      }
                      if (
                        !this.closed &&
                        generation === this.submenuGeneration &&
                        popup &&
                        !popup.isDestroyed() &&
                        this.submenuWindow === popup
                      ) {
                        popup.focus();
                      }
                    },
                    () => {
                      disposePending();
                      closeUnavailable();
                    }
                  );
                },
                closeUnavailable
              );
              if (
                !this.closed &&
                generation === this.submenuGeneration &&
                popup?.isDestroyed() === false &&
                this.submenuWindow === popup
              ) {
                this.submenuCleanups.push(cancelArm);
              } else {
                cancelArm();
              }
            };
            bind(popup, false, showAsPopup);
            const dismissOnSubmenuWheel = (
              _event: Electron.Event,
              input: Electron.MouseInputEvent
            ) => {
              if (input.type === "mouseWheel") this.close();
            };
            popup.webContents.on("before-mouse-event", dismissOnSubmenuWheel);
            this.submenuCleanups.push(() => {
              if (popup && !popup.isDestroyed()) {
                popup.webContents.off(
                  "before-mouse-event",
                  dismissOnSubmenuWheel
                );
              }
            });
            popup.on("closed", () => {
              if (this.submenuWindow !== popup) return;
              this.submenuWindow = null;
              this.submenuGeneration++;
              for (const cleanup of this.submenuCleanups.splice(0)) cleanup();
            });
            popup.on("blur", () => {
              setTimeout(() => {
                if (generation !== this.submenuGeneration) return;
                if (!parent.isDestroyed() && parent.isFocused()) return;
                if (!this.closed) this.close();
              }, 100);
            });
          } catch {
            if (popup && !popup.isDestroyed()) popup.destroy();
            if (generation === this.submenuGeneration) {
              this.closeSubmenuWindow();
            }
          }
        },
        openSubmenu: async () => {},
        closeSubmenu: async () => {},
      });
    };

    try {
      bind(measure, true);
    } catch {
      if (this.submenuMeasureWindow === measure) {
        this.submenuMeasureWindow = null;
        this.submenuGeneration++;
      }
      if (!measure.isDestroyed()) measure.destroy();
      for (const cleanup of this.submenuCleanups.splice(0)) cleanup();
    }
  }

  // --- Wayland: fullscreen transparent overlay ---
  // Created fresh each time so the compositor sends pointer-enter,
  // which the renderer uses to capture the real cursor position.
  private showOverlay() {
    let cancelCursorCapture = () => {};
    let finishCursorCapture = () => {};
    let startCursorCapture = () => {};
    const cursorPosition = new Promise<{ cursorX: number; cursorY: number }>(
      (resolve) => {
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
          deadline = setTimeout(
            () => finish(),
            WAYLAND_CURSOR_CAPTURE_DEADLINE_MS
          );
          try {
            const token = captureNextWindowFirstCursorEnter(
              (cursorX, cursorY) => {
                finish(cursorX, cursorY);
              }
            );
            cancelCursorCapture = () => {
              cancelNextWindowFirstCursorEnter(token);
            };
          } catch {
            finish();
          }
        };
      }
    );
    this.dismissCleanups.push(() => {
      finishCursorCapture();
    });

    const wnd = createOverlayWindow();
    let rendererReady = false;
    const rendererDeadline = setTimeout(() => {
      if (!rendererReady && !this.closed) this.close();
    }, MENU_RENDER_READY_TIMEOUT_MS);
    this.dismissCleanups.push(() => clearTimeout(rendererDeadline));

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
        clearTimeout(rendererDeadline);
        if (!this.closed && !wnd.isDestroyed()) {
          // Arm the global "next toplevel" watcher immediately before mapping
          // the already-created target, minimizing the ownership window.
          startCursorCapture();
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
    registerInputRegionHandlers(wnd);
  }

  // --- Non-Wayland: transparent popup BrowserWindow ---
  private showWindow() {
    const de = getDesktopEnvironment();

    const wnd = createMenuWindow();
    let rendererReady = false;
    const rendererDeadline = setTimeout(() => {
      if (!rendererReady && !this.closed) this.close();
    }, MENU_RENDER_READY_TIMEOUT_MS);
    this.dismissCleanups.push(() => clearTimeout(rendererDeadline));
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
      const rendererDeadline = setTimeout(() => {
        if (generation === this.submenuGeneration) this.closeSubmenuWindow();
      }, MENU_RENDER_READY_TIMEOUT_MS);
      this.submenuCleanups.push(() => clearTimeout(rendererDeadline));
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
          for (const cleanup of this.submenuCleanups.splice(0)) cleanup();
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
            clearTimeout(rendererDeadline);
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
          setTimeout(() => {
            if (generation !== this.submenuGeneration) return;
            // If focus went back to the main menu, keep open
            if (!wnd.isDestroyed() && wnd.isFocused()) return;
            if (!this.closed) {
              this.close();
            }
          }, 100);
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
        clearTimeout(rendererDeadline);
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
