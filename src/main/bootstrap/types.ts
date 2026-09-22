import type { Database } from "@open-orpheus/database";
import type { BrowserWindow } from "electron";
import type Emittery from "emittery";
import type { Keyv } from "keyv";
import type { Logger } from "pino";

import type { SettingsEvents } from "@shared/types/settings";
import type { LifecycleService } from "../services/lifecycle";

// Keeps its documented home (§5.3) while living in `src/shared`, where the
// preload and bridge planes can reach it without importing `@main/**`.
export type { Disposable } from "@shared/disposable";

export type OpenDatabase = (path: string) => Database;

/** The renderer side of a window that services push events through. */
export interface RendererTarget {
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/**
 * Indirection over the main window: it does not exist when services are
 * constructed, and it becomes unusable once destroyed.
 */
export interface MainWindowAccessor {
  current(): RendererTarget | null;
}

export interface WindowService extends MainWindowAccessor {
  /**
   * The main window itself, for consumers that need more than a renderer target:
   * geometry, `isDestroyed`, or wrapping the window into a `ManagedWindow`.
   */
  currentWindow(): BrowserWindow | null;
  setMainWindow(wnd: BrowserWindow | null): void;
}

/**
 * Injectable process boundaries. Tests substitute here rather than mocking our
 * own modules. `logger` has no default because importing the logger module opens
 * log files and pulls in electron, which would make the root untestable.
 */
export interface HostDeps {
  logger: Logger;
  openDatabase?: OpenDatabase;
}

export interface BootstrapPhase {
  logger: Logger;
}

export interface DatabaseService {
  webDb: Database;
  musicLibraryDb: Database;
  nativeDb: Database;
}

export interface SettingsService {
  kv: Keyv;
  events: Emittery<SettingsEvents>;
}

/** Only `bootstrap()` produces this, so initialisation order is enforced by type. */
export interface ReadyPhase extends BootstrapPhase {
  lifecycle: LifecycleService;
  windows: WindowService;
  database: DatabaseService;
  settings: SettingsService;
}
