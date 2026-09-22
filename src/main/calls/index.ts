import type { Disposable } from "@shared/disposable";

import { register as registerApp, type AppDeps } from "./handlers/app";
import {
  register as registerAudioeffect,
  type AudioeffectDeps,
} from "./handlers/audioeffect";
import {
  register as registerBrowser,
  type BrowserDeps,
} from "./handlers/browser";
import { register as registerDesktop } from "./handlers/desktop";
import { register as registerDownload } from "./handlers/download";
import {
  register as registerMusiclibrary,
  type MusiclibraryDeps,
} from "./handlers/musiclibrary";
import { register as registerNetwork } from "./handlers/network";
import { register as registerOs } from "./handlers/os";
import { register as registerPlayer } from "./handlers/player";
import { register as registerProcess } from "./handlers/process";
import { register as registerRtc } from "./handlers/rtc";
import {
  register as registerStorage,
  type StorageDeps,
} from "./handlers/storage";
import {
  register as registerTrayicon,
  type TrayiconDeps,
} from "./handlers/trayicon";
import { register as registerUpdate } from "./handlers/update";
import {
  register as registerWinhelper,
  type WinhelperDeps,
} from "./handlers/winhelper";

export type CallModuleDeps = AppDeps &
  AudioeffectDeps &
  BrowserDeps &
  MusiclibraryDeps &
  StorageDeps &
  TrayiconDeps &
  WinhelperDeps;

export function registerCallModules(deps: CallModuleDeps): Disposable {
  registerApp(deps);
  registerAudioeffect(deps);
  const winhelper = registerWinhelper(deps);
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

  // `winhelper` is the only module here that acquires anything; the other
  // fourteen register `channel.call` commands, which are permanent by design
  // and carry no `Disposable` (see `CallDispatcher`).
  return winhelper;
}
