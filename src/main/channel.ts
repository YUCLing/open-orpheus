import { ipcMain } from "electron";
import { dispatcher } from "./calls";
import {
  deData,
  deserialData,
  encodeAnonymousId,
  enData,
  SERIAL_AES_KEY,
  serialData,
} from "./crypto";

import "./calls/index";

ipcMain.handle(
  "channel.call",
  (event, command: string, ...params: unknown[]) => {
    return new Promise((resolve) => {
      dispatcher
        .dispatch(
          command,
          (...args) => {
            resolve(args);
          },
          event,
          ...params
        )
        .then((result) => {
          if (result === false) {
            resolve(false); // No handler found for the command
          }
        });
    });
  }
);

ipcMain.on("channel.enData", (event, plaintext: string) => {
  const ciphertext = enData(plaintext);
  event.returnValue = ciphertext;
});

ipcMain.on("channel.deData", (event, doubleBase64: string) => {
  const plaintextBuf = deData(doubleBase64);
  event.returnValue = plaintextBuf ? plaintextBuf.toString("utf8") : null;
});

ipcMain.on(
  "channel.serialData",
  (event, apiPath: string, body: string | object) => {
    const hexParams = serialData(apiPath, body);
    event.returnValue = hexParams;
  }
);

ipcMain.on("channel.deserialData", (event, hexParams: string | ArrayBuffer) => {
  const deserialized = deserialData(hexParams);
  event.returnValue = deserialized;
});

ipcMain.on("channel.encodeAnonymousId", (event, id: string) => {
  event.returnValue = Buffer.from(id + " " + encodeAnonymousId(id)).toString("base64");
});

ipcMain.on("channel.serialKey", (event, key: string) => {
  const ciphertext = enData(key, SERIAL_AES_KEY, false);
  event.returnValue = ciphertext;
});
