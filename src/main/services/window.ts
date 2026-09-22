import type { BrowserWindow } from "electron";

import type { WindowService } from "../bootstrap/types";

/**
 * Creates an independent main-window holder.
 *
 * The state is per instance, not per module, so two composition roots built in
 * the same process — two `createTestContext()` calls, for example — cannot
 * observe each other's main window. A module-level binding made that leak
 * unavoidable: the phase handed the same mutable object to every caller.
 *
 * The service is still a process-level singleton *in production*, because
 * `bootstrap()` runs once per process and `main.ts` keeps the instance it is
 * given. That is a property of how it is used, not of where it is stored.
 */
export function createWindowService(): WindowService {
  let mainWindow: BrowserWindow | null = null;

  return {
    current: () => mainWindow,
    currentWindow: () => mainWindow,
    setMainWindow: (wnd) => {
      mainWindow = wnd;
    },
  };
}
