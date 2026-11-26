import { screen } from "electron";

import {
  captureCursorEnter,
  getWindowOutputDisplayId,
  LayerShellLayer,
} from "@open-orpheus/window";
import { LAYER_CAPTURE_TIMEOUT_MS } from "../constants";
import { LayerCaptureWindow } from "../../window";

const CAPTURE_TITLE = "Open Orpheus Menu Capture";
const CAPTURE_NAMESPACE = "open-orpheus-menu-capture";
const TRANSPARENT_PAGE = "data:text/html,<body style='background:transparent'></body>";

export interface LayerCaptureResult {
  x: number;
  y: number;
  displayId: number;
}

/**
 * A transparent fullscreen layer window whose only job is to receive the
 * pointer enter Wayland will not report without a surface.
 *
 * The compositor chooses the output because the policy omits `output`; the
 * proxy reports which output the surface entered, so placement can use that
 * display's bounds without guessing from the global cursor.
 */
export class CaptureLayerSurface {
  private readonly host: LayerCaptureWindow;
  private closed = false;
  private released = false;

  constructor() {
    const display = screen.getPrimaryDisplay();
    this.host = new LayerCaptureWindow(
      {
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        width: display.bounds.width,
        height: display.bounds.height,
        resizable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        webPreferences: {
          partition: "open-orpheus",
          backgroundThrottling: false,
        },
      },
      {
        namespace: CAPTURE_NAMESPACE,
        layer: LayerShellLayer.Overlay,
        anchorTop: true,
        anchorBottom: true,
        anchorLeft: true,
        anchorRight: true,
        width: 0,
        height: 0,
        exclusiveZone: -1,
        keyboardInteractivity: 0,
      },
      CAPTURE_TITLE
    );
    this.host.window?.on("closed", () => this.close());
  }

  async capture(timeoutMs = LAYER_CAPTURE_TIMEOUT_MS): Promise<LayerCaptureResult> {
    const window = this.host.window;
    if (!window || window.isDestroyed()) throw new Error("capture window is gone");
    try {
      await window.loadURL(TRANSPARENT_PAGE);
      if (this.closed) throw new Error("capture window closed");
      // Arm before mapping: a pointer enter emitted as the surface appears
      // must have a watcher already in place.
      const pointerPromise = captureCursorEnter(this.host.id, timeoutMs);
      window.show();
      const pointer = await pointerPromise;
      if (!pointer) throw new Error("layer-shell cursor capture timed out");
      const displayId = await this.waitForDisplayId();
      if (displayId === null) throw new Error("capture surface did not enter an output");
      return { x: pointer[0], y: pointer[1], displayId };
    } finally {
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    if (this.released) return;
    this.released = true;
    const window = this.host.window;
    if (window && !window.isDestroyed()) window.destroy();
    this.host.releaseNativeState();
  }

  private async waitForDisplayId(): Promise<number | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const displayId = getWindowOutputDisplayId(this.host.id);
      if (displayId !== null) return displayId;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }
}
