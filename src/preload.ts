// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from "electron";

import { channel } from "./preload/util";

import "./preload/channel";
import { fireNativeCall } from "./preload/channel";

import "./preload/calls/index";

async function getSCFonts(): Promise<string[]> {
  const fonts = (await ipcRenderer.invoke("fonts.getSCFonts")) as string[];
  LOGGER.debug({ count: fonts.length }, "Fetched system fonts for font patch");
  return fonts;
}

const mainWorldInterface = {
  getSCFonts,
  fireNativeCall,
  dragWindow: () => ipcRenderer.invoke("channel.call", "winhelper.dragWindow"),
};

LOGGER.debug({ channel }, "Installing main-world patches");
contextBridge.executeInMainWorld({
  func: (channel: string, api: typeof mainWorldInterface) => {
    const originalContentDocumentDescriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "contentDocument"
    );
    if (originalContentDocumentDescriptor) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
        get() {
          const contentDocument = originalContentDocumentDescriptor.get?.call(this);
          if (!contentDocument) {
            // Create a fake contentDocument to prevent load-fail
            const fakeDocument = { body: { textContent: "N" } };
            return fakeDocument;
          }
          return contentDocument;
        },
      });
    }

    // Referenced unbound on purpose: invoked below via .apply with the receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string,
      ...args: unknown[]
    ) {
      if (typeof url === "string" && url.startsWith("http://music.163.com/api/nos/token/alloc")) {
        // Rewrite the URL before the browser even knows about it
        url = url.replace("http://", "https://");
      }
      return originalOpen.apply(this, [method, url, ...args] as unknown as Parameters<
        typeof XMLHttpRequest.prototype.open
      >);
    } as unknown as typeof XMLHttpRequest.prototype.open;

    const OriginalImage = Image;
    // Make sure music recognition's thumbnail preview works
    window.Image = function (width?: number, height?: number) {
      const img = new OriginalImage(width, height);
      img.crossOrigin = "anonymous";
      return img;
    } as unknown as typeof Image;

    if (channel === "main") {
      const systemFonts = new Set();

      void api.getSCFonts().then((fonts) => {
        for (const font of fonts) systemFonts.add(font);
      });

      // Referenced unbound on purpose: invoked below via .call with the receiver.
      // oxlint-disable-next-line typescript/unbound-method
      const origTest = RegExp.prototype.test;
      RegExp.prototype.test = function (str) {
        // The CJK font-name filter regex in settings.
        // Force it to always pass so all system fonts appear in the font picker.
        if (this.source === "[\\u4E00-\\u9FA5]" && systemFonts.has(str)) return true;
        return origTest.call(this, str);
      };

      // Force desktop lyrics preview to refresh when updated
      const originalSrcPropertyDescriptor = Object.getOwnPropertyDescriptor(
        OriginalImage.prototype,
        "src"
      );
      if (originalSrcPropertyDescriptor) {
        Object.defineProperty(OriginalImage.prototype, "src", {
          set(value) {
            if (
              typeof value !== "string" ||
              value !== "orpheus://orpheus/storage/local?file=preview/font.png"
            ) {
              originalSrcPropertyDescriptor.set?.call(this, value);
              return;
            }
            originalSrcPropertyDescriptor.set?.call(this, value + "&t=" + Date.now());
          },
        });
      }

      let fallbackTimeout: NodeJS.Timeout | null = null;
      // We have Electron handle resize handlers for us, so we drop its own handlers to avoid "not responding" resizes
      const handlerRemover = () => {
        const handlers = document.querySelectorAll('[class*="App"] > [class*="Handler"]');
        if (handlers.length === 0) {
          if (fallbackTimeout === null) {
            // Fallback in case there was no handler at all, so long-term performance won't be affected.
            fallbackTimeout = setTimeout(() => {
              window.removeEventListener("mousemove", handlerRemover);
              // Try last time here
              handlerRemover();
            }, 3000);
          }
          return;
        }
        window.removeEventListener("mousemove", handlerRemover);
        for (const handler of handlers) {
          handler.remove();
        }
        if (fallbackTimeout) clearTimeout(fallbackTimeout);
      };
      // Use `mousemove` because this means the app is fully ready
      window.addEventListener("mousemove", handlerRemover);
    } else if (channel === "pet") {
      // #region Pointer utilities
      // From /gui/src/lib/pointer.ts
      const THRESHOLD_SQ = 2;
      function onpointerdrag(el: HTMLElement, callback: (e: PointerEvent) => void) {
        let pointerId: number | null = null;
        let sx = 0,
          sy = 0;

        const onpointerdown = (e: PointerEvent) => {
          if (pointerId !== null) return;
          if (e.pointerType === "mouse" && e.button !== 0) return; // For mouse, only track left button

          e.preventDefault();

          pointerId = e.pointerId;
          sx = e.clientX;
          sy = e.clientY;

          window.addEventListener("pointermove", onpointermove);
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
          window.addEventListener("blur", stop);
        };

        const onpointermove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          const dx = e.clientX - sx,
            dy = e.clientY - sy;
          if (dx * dx + dy * dy >= THRESHOLD_SQ) {
            stop();
            callback(e);
          }
        };

        const stop = (e?: PointerEvent | FocusEvent) => {
          if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
          pointerId = null;
          window.removeEventListener("pointermove", onpointermove);
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          window.removeEventListener("blur", stop);
        };

        el.addEventListener("pointerdown", onpointerdown);

        return () => {
          el.removeEventListener("pointerdown", onpointerdown);
          stop();
        };
      }

      function getMouseEvent(type: string, event: PointerEvent) {
        const x = event.clientX,
          y = event.clientY,
          scale = window.devicePixelRatio,
          px = x * scale,
          py = y * scale;
        return { type, x, y, px, py };
      }
      function subscribeMouseEvent<K extends keyof HTMLElementEventMap>(
        el: HTMLElement,
        event: K,
        type: string
      ) {
        const handler = (e: Event) => {
          if (!(e instanceof PointerEvent)) return;
          api.fireNativeCall("desktoppet.onMouseEvent", getMouseEvent(type, e));
        };
        el.addEventListener(event, handler);
        return () => el.removeEventListener(event, handler);
      }
      // #endregion
      addEventListener("DOMContentLoaded", () => {
        let currentRenderer: HTMLElement | null = null;
        let unsubscribe: (() => void) | null = null;
        const observer = new MutationObserver(() => {
          const renderer = document.getElementById("pet-desktop-renderer");
          if (!renderer || currentRenderer === renderer) return;
          if (unsubscribe) unsubscribe();
          currentRenderer = renderer;
          // We need to capture the mouse events, so we cannot use this.
          renderer.style.setProperty("-webkit-app-region", "no-drag");
          const unsubs = [
            subscribeMouseEvent(renderer, "pointerenter", "hoverenter"),
            subscribeMouseEvent(renderer, "pointerleave", "hoverleave"),
            subscribeMouseEvent(renderer, "pointermove", "hover"),
            subscribeMouseEvent(renderer, "click", "click"),
            onpointerdrag(renderer, api.dragWindow),
          ];
          unsubscribe = () => {
            for (const unsub of unsubs) unsub();
          };
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["id"],
        });
      });
    }
  },
  args: [channel, mainWorldInterface],
});
