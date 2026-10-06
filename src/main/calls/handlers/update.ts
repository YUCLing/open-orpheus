import { BrowserWindow, dialog } from "electron";

import { registerCallHandler } from "../dispatcher";

export function register(): void {
  registerCallHandler<
    [
      {
        filename: string;
        hash: string;
        installVer: string;
        installtype: string;
        params: string;
        patchMd5: string;
        patchRawVer: string;
        patchUrl: string;
        patchUrlHeader: string;
        url: string;
        urlHeader: string;
        xmlDownloadUrl: string;
      },
    ],
    void
  >("update.startUpdate", (event) => {
    // Let update window show first before the dialog (if update is triggered manually)
    setTimeout(async () => {
      const wnd = BrowserWindow.fromWebContents(event.sender);
      if (!wnd) throw new Error("Main window's dead?");
      await dialog.showMessageBox(wnd, {
        title: "Open Orpheus",
        message:
          "由于更新包和 Open Orpheus 的特殊性，Open Orpheus 无法支持在网易云内更新，十分抱歉。",
      });
      event.sender.send(
        "channel.call",
        "update.onupdateprogress",
        "", // currentFile
        0, // downloadPercent
        0, // totalPercent
        true, // isEnd
        1, // code
        "" // ext?
      );
    }, 500);
  });
}
