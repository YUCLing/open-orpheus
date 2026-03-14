import { contextBridge } from "electron";

if (location.search.includes("route=miniProgram")) {
  // For mini program, we need to hack HTMLIFrameElement.prototype.contentDocument to make sure load-fail won't be triggered
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
              originalContentDocumentDescriptor.get.call(this);
            if (!contentDocument) {
              // Create a fake contentDocument to prevent load-fail
              const fakeDocument = { body: { textContent: "N" } };
              return fakeDocument;
            }
            return contentDocument;
          },
        });
      }
    },
  });
}
