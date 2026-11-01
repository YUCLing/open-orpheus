import type { BrowserWindow } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  supportsNativeWaylandPopup,
} from "@open-orpheus/window";

import { toError } from "@shared/util";
import { events, LifecycleState, state } from "../lifecycle";
import { runMenuCallbacks } from "./lifecycle";
import {
  clearNativeWaylandPopup,
  registerNativeWaylandPopup,
  waitForWaylandPopup,
  waylandWindowId,
} from "./native-popup";
import { createPopupProbeWindow } from "./windows";

// A desktop name or an xdg-shell global cannot prove our role mapping works.
// Cache confirmed support in this process; retry inconclusive probes.
let nativePopupSupported: boolean | undefined;
let popupSupportProbe: Promise<boolean> | null = null;

export async function initializeWaylandPopupSupport(parent: BrowserWindow): Promise<boolean> {
  if (nativePopupSupported !== undefined) {
    return nativePopupSupported;
  }
  if (popupSupportProbe) {
    return popupSupportProbe;
  }
  if (parent.isDestroyed() || state === LifecycleState.Quitting) return false;
  try {
    const desktopEnvironment = getDesktopEnvironment();
    if (desktopEnvironment !== DesktopEnvironment.Wayland || !supportsNativeWaylandPopup()) {
      nativePopupSupported = false;
      LOGGER.debug(
        { desktopEnvironment },
        "Native Wayland popups unavailable; menus will use the overlay"
      );
      return false;
    }
  } catch (error) {
    LOGGER.warn({ err: toError(error) }, "Wayland popup availability check failed");
    return false;
  }
  popupSupportProbe = probePopup(parent)
    .then((result) => {
      // Missing role data, timeouts and cancellation do not prove incompatibility.
      if (result !== null && nativePopupSupported === undefined) {
        nativePopupSupported = result;
        if (result) {
          LOGGER.debug("Native Wayland popup support confirmed");
        }
      } else if (result === null) {
        LOGGER.trace("Wayland popup support probe was inconclusive");
      }
      return nativePopupSupported ?? false;
    })
    .finally(() => {
      popupSupportProbe = null;
    });
  return popupSupportProbe;
}

async function probePopup(parent: BrowserWindow): Promise<boolean | null> {
  let cancelled = false;
  const cleanups: Array<() => void> = [];
  try {
    const supported = await new Promise<boolean | null>((resolve) => {
      let settled = false;
      const finish = (result: boolean | null) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const cancel = () => {
        cancelled = true;
        finish(null);
      };
      parent.once("closed", cancel);
      cleanups.push(() => parent.off("closed", cancel));
      cleanups.push(events.on("quitting", cancel));
      try {
        const probe = createPopupProbeWindow();
        cleanups.push(() => {
          if (!probe.isDestroyed()) probe.destroy();
        });
        probe.once("closed", cancel);
        cleanups.push(() => probe.off("closed", cancel));
        const isCancelled = () =>
          cancelled || settled || parent.isDestroyed() || probe.isDestroyed();
        const probeId = waylandWindowId(probe);
        if (
          !registerNativeWaylandPopup(waylandWindowId(parent), probeId, 1, 1, { x: 0, y: 0 }, 0)
        ) {
          finish(null);
          return;
        }
        cleanups.push(() => clearNativeWaylandPopup(probeId));
        try {
          probe.showInactive();
          void waitForWaylandPopup(probeId, isCancelled).then(
            (converted) => {
              finish(converted ? true : null);
            },
            (error) => {
              LOGGER.warn({ err: toError(error) }, "Wayland popup probe conversion failed");
              finish(null);
            }
          );
        } catch (error) {
          LOGGER.warn({ err: toError(error) }, "Wayland popup probe show failed");
          finish(null);
        }
      } catch (error) {
        LOGGER.warn({ err: toError(error) }, "Wayland popup probe initialization failed");
        finish(null);
      }
    });
    return cancelled ? null : supported;
  } finally {
    runMenuCallbacks(cleanups.splice(0).reverse(), (error) => {
      LOGGER.warn({ err: toError(error) }, "Wayland popup probe cleanup failed");
    });
  }
}
