// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge } from "electron";

import "./preload/channel";

import "./preload/calls/index";

const isMain = process.argv.includes("--preload-channel=main");

if (isMain) {
  // Lyrics is only used in main window
  import("./preload/lyrics");
}

contextBridge.executeInMainWorld({
  func: (isMain: boolean) => {
    const originalContentDocumentDescriptor = Object.getOwnPropertyDescriptor(
      HTMLIFrameElement.prototype,
      "contentDocument"
    );
    if (originalContentDocumentDescriptor) {
      Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
        get() {
          const contentDocument =
            originalContentDocumentDescriptor.get?.call(this);
          if (!contentDocument) {
            // Create a fake contentDocument to prevent load-fail
            const fakeDocument = { body: { textContent: "N" } };
            return fakeDocument;
          }
          return contentDocument;
        },
      });
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string,
      ...args: unknown[]
    ) {
      if (
        typeof url === "string" &&
        url.startsWith("http://music.163.com/api/nos/token/alloc")
      ) {
        // Rewrite the URL before the browser even knows about it
        url = url.replace("http://", "https://");
      }
      return originalOpen.apply(this, [
        method,
        url,
        ...args,
      ] as unknown as Parameters<typeof XMLHttpRequest.prototype.open>);
    } as unknown as typeof XMLHttpRequest.prototype.open;

    const OriginalImage = Image;
    // Make sure music recognition's thumbnail preview works
    window.Image = function (width?: number, height?: number) {
      const img = new OriginalImage(width, height);
      img.crossOrigin = "anonymous";
      return img;
    } as unknown as typeof Image;

    if (isMain) {
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
            originalSrcPropertyDescriptor.set?.call(
              this,
              value + "&t=" + Date.now()
            );
          },
        });
      }

      let fallbackTimeout: NodeJS.Timeout | null = null;
      // We have Electron handle resize handlers for us, so we drop its own handlers to avoid "not responding" resizes
      const handlerRemover = () => {
        const handlers = document.querySelectorAll(
          '[class*="App"] > [class*="Handler"]'
        );
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
    }
  },
  args: [isMain],
});
