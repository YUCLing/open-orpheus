import { register as registerApp } from "./app";
import { register as registerAudioeffect } from "./audioeffect";
import { register as registerBrowser } from "./browser";
import { register as registerDesktop } from "./desktop";
import { register as registerDownload } from "./download";
import { register as registerMusiclibrary } from "./musiclibrary";
import { register as registerNetwork } from "./network";
import { register as registerOs } from "./os";
import { register as registerPlayer } from "./player";
import { register as registerProcess } from "./process";
import { register as registerRtc } from "./rtc";
import { register as registerStorage } from "./storage";
import { register as registerTrayicon } from "./trayicon";
import { register as registerUpdate } from "./update";
import { register as registerWinhelper } from "./winhelper";

export function registerCallModules(): void {
  registerApp();
  registerAudioeffect();
  registerWinhelper();
  registerBrowser();
  registerDesktop();
  registerStorage();
  registerMusiclibrary();
  registerOs();
  registerTrayicon();
  registerNetwork();
  registerDownload();
  registerRtc();
  registerUpdate();
  registerPlayer();
  registerProcess();
}
