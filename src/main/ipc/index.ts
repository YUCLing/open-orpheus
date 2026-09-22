import { register as registerApp, type AppDeps } from "./app";
import {
  register as registerAudioeffect,
  type AudioeffectDeps,
} from "./audioeffect";
import { register as registerBrowser, type BrowserDeps } from "./browser";
import { register as registerDesktop } from "./desktop";
import { register as registerDownload } from "./download";
import {
  register as registerMusiclibrary,
  type MusiclibraryDeps,
} from "./musiclibrary";
import { register as registerNetwork } from "./network";
import { register as registerOs } from "./os";
import { register as registerPlayer } from "./player";
import { register as registerProcess } from "./process";
import { register as registerRtc } from "./rtc";
import { register as registerStorage, type StorageDeps } from "./storage";
import { register as registerTrayicon, type TrayiconDeps } from "./trayicon";
import { register as registerUpdate } from "./update";
import { register as registerWinhelper, type WinhelperDeps } from "./winhelper";

export type CallModuleDeps = AppDeps &
  AudioeffectDeps &
  BrowserDeps &
  MusiclibraryDeps &
  StorageDeps &
  TrayiconDeps &
  WinhelperDeps;

export function registerCallModules(deps: CallModuleDeps): void {
  registerApp(deps);
  registerAudioeffect(deps);
  registerWinhelper(deps);
  registerBrowser(deps);
  registerDesktop();
  registerStorage(deps);
  registerMusiclibrary(deps);
  registerOs();
  registerTrayicon(deps);
  registerNetwork();
  registerDownload();
  registerRtc();
  registerUpdate();
  registerPlayer();
  registerProcess();
}
