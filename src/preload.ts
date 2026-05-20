// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge } from "electron";

import "./preload/channel";
import "./preload/desktopLyrics";

import "./preload/calls/index";

contextBridge.executeInMainWorld({
  func: () => {
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

    const OriginalImage = window.Image;
    window.Image = function (width?: number, height?: number) {
      const img = new OriginalImage(width, height);
      img.crossOrigin = "anonymous";
      return img;
    } as unknown as typeof Image;
  },
});
