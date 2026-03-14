import { ipcMain, protocol } from "electron";

import mime from "mime";
import { extname, resolve } from "node:path";

// eslint-disable-next-line import/no-unresolved
import BetterNCM from "better-ncm-framework";

import { data as dataPath } from "../main/folders";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { VERSION as NCM_VERSION } from "..//constants";

const basePath = resolve(dataPath, "betterncm");

const apiKey = crypto.randomUUID();

ipcMain.on("betterncm.isPresent", (event) => {
  event.returnValue = BetterNCM !== null;
});

if (BetterNCM) {
  ipcMain.on("betterncm.apiKey", (event) => {
    event.returnValue = apiKey;
  });

  ipcMain.on("betterncm.fs.readDir", (event, path) => {
    readdir(resolve(basePath, path))
      .then((files) => {
        event.returnValue = files.map((x) => resolve(basePath, path, x));
      })
      .catch(() => {
        event.returnValue = null;
      });
  });

  ipcMain.on("betterncm.fs.readFileText", (event, path) => {
    readFile(resolve(basePath, path), "utf-8")
      .then((content) => {
        event.returnValue = content;
      })
      .catch(() => {
        event.returnValue = null;
      });
  });

  ipcMain.on("betterncm.fs.exists", (event, path) => {
    try {
      const exists = existsSync(resolve(basePath, path));
      event.returnValue = exists;
    } catch {
      event.returnValue = false;
    }
  });

  protocol.registerSchemesAsPrivileged([
    {
      scheme: "betterncm",
      privileges: {
        secure: true,
        standard: true,
        bypassCSP: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

export function registerBetterNCMScheme() {
  if (!BetterNCM) return;
  protocol.handle("betterncm", async (request) => {
    const url = new URL(request.url);
    switch (url.hostname) {
      case "betterncm": {
        const resourceName = url.pathname.substring(1); // remove leading '/'
        let resource =
          BetterNCM.resources?.[
            resourceName as keyof typeof BetterNCM.resources
          ];
        if (resource) {
          const contentType =
            mime.getType(extname(resourceName)) || "application/octet-stream";
          if (resourceName === "framework.js") {
            // Script is always executed after DOMContentLoaded, this is a little hack.
            resource = resource.replaceAll("DOMContentLoaded", "loadbetterncm");
          }
          return new Response(resource, {
            headers: { "Content-Type": contentType },
          });
        } else {
          return new Response("Not Found", { status: 404 });
        }
      }
      case "api": {
        for (const file of ["framework.css", "framework.css.map"]) {
          if (url.pathname === `/internal/${file}`) {
            const contentType =
              mime.getType(extname(file)) || "application/octet-stream";
            return new Response(BetterNCM.resources[file], {
              headers: { "Content-Type": contentType },
            });
          }
        }
        switch (url.pathname) {
          case "/app/read_config": {
            //const key = url.searchParams.get("key");
            const defaultValue = url.searchParams.get("default");
            return new Response(defaultValue);
          }
          case "/app/version": {
            return new Response(NCM_VERSION);
          }
        }
        return new Response("Not Found", { status: 404 });
      }
    }
  });
}

export function patchMainWindowForBetterNCM(
  mainWindow: Electron.BrowserWindow
) {
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      const url = new URL(details.url);
      if (url.hostname.endsWith("163.com")) {
        callback({});
        return;
      }

      for (const responseHeader in details.responseHeaders) {
        if (responseHeader.toLowerCase() === "access-control-allow-origin") {
          delete details.responseHeaders[responseHeader];
        }
      }

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Access-Control-Allow-Origin": ["orpheus://orpheus"],
          "Access-Control-Allow-Methods": ["GET, POST, PUT, DELETE, OPTIONS"],
          "Access-Control-Allow-Headers": ["*"],
        },
      });
    }
  );
}
