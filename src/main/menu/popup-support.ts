import type { BrowserWindow } from "electron";
import {
  DesktopEnvironment,
  getDesktopEnvironment,
  supportsNativeWaylandPopup,
} from "@open-orpheus/window";

import { toError } from "../../util";
import { events, LifecycleState, state } from "../lifecycle";
import { runMenuCallbacks } from "./lifecycle";
import {
  armNativeWaylandPopupWhenReady,
  waitForWaylandPopup,
  waylandWindowId,
} from "./native-popup";
import { createPopupProbeWindow } from "./windows";

// A desktop name or an xdg-shell global cannot prove our role mapping works.
// Cache the completed startup probe, including failure, for this process.
// A cancelled probe may retry with a live parent.
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
    if (getDesktopEnvironment() !== DesktopEnvironment.Wayland || !supportsNativeWaylandPopup()) {
      nativePopupSupported = false;
      return false;
    }
  } catch (error) {
    LOGGER.warn({ err: toError(error) }, "Wayland popup availability check failed");
    return false;
  }
  popupSupportProbe = probePopup(parent)
    .then((result) => {
      // Cancellation is not a completed capability check. A timed-out probe
      // chooses overlay for this session instead of delaying every menu click.
      if (result !== null && nativePopupSupported === undefined) {
        nativePopupSupported = result;
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
        cleanups.push(
          armNativeWaylandPopupWhenReady(
            waylandWindowId(parent),
            waylandWindowId(probe),
            1,
            1,
            { x: 0, y: 0 },
            isCancelled,
            (disposePending) => {
              cleanups.push(disposePending);
              try {
                probe.showInactive();
                void waitForWaylandPopup(waylandWindowId(probe), isCancelled).then(
                  (converted) => {
                    finish(converted);
                  },
                  (error) => {
                    LOGGER.warn({ err: toError(error) }, "Wayland popup probe conversion failed");
                    finish(false);
                  }
                );
              } catch (error) {
                LOGGER.warn({ err: toError(error) }, "Wayland popup probe show failed");
                finish(false);
              }
            },
            (_reason, error) => {
              if (error !== undefined) {
                LOGGER.warn({ err: toError(error) }, "Wayland popup probe arming failed");
              }
              finish(false);
            },
            0
          )
        );
      } catch (error) {
        LOGGER.warn({ err: toError(error) }, "Wayland popup probe initialization failed");
        finish(false);
      }
    });
    return cancelled ? null : supported;
  } finally {
    runMenuCallbacks(cleanups.splice(0).reverse(), (error) => {
      LOGGER.warn({ err: toError(error) }, "Wayland popup probe cleanup failed");
    });
  }
}
