import { App } from "@open-orpheus/ui";
import { getSkinPack, webPack } from "./pack";

let appInstance: App | null = null;

export function getApp(): App {
  if (!appInstance) {
    throw new Error("App instance not created yet");
  }
  return appInstance;
}

export async function createApp(isWayland: boolean) {
  if (appInstance) {
    throw new Error("App instance already created");
  }
  appInstance = await App.create({
    preferWayland: isWayland,
    readWebPack: webPack.readFile.bind(webPack),
    readSkinPack: (path: string) => {
      const skinPack = getSkinPack();
      return skinPack.readFile(path);
    }
  });
}
