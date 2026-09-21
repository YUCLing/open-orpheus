import type { Database } from "@open-orpheus/database";
import type Emittery from "emittery";
import type { Keyv } from "keyv";
import type { Logger } from "pino";

import type { SettingsEvents } from "$sharedTypes/settings";

export interface Disposable {
  dispose(): void;
}

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
  database: DatabaseService;
  settings: SettingsService;
}
