import type { BrowserWindow } from "electron";
import Emittery from "emittery";
import type { Logger } from "pino";

import { toError } from "@shared/util";

export enum LifecycleState {
  Starting,
  MainWindowCreated,
  MainWindowLoaded,
  Started,
  Quitting,
}

export type LifecycleEvents = {
  /**
   * This event fires when main window has just been created, and the content
   * is not loaded yet.
   *
   * Note that in this event, `mainWindow` is not set yet, but you can get it
   * in the event data.
   */
  mainwindowcreated: BrowserWindow;
  mainwindowloaded: BrowserWindow;
  /**
   * This event fires when app is fully started and ready.
   *
   * At this point, `mainWindow` should be fully available to use, if not,
   * something's seriously wrong.
   */
  started: undefined;
  quitting: undefined;
};

const STATE_EVENT_MAP = {
  [LifecycleState.MainWindowCreated]: "mainwindowcreated",
  [LifecycleState.MainWindowLoaded]: "mainwindowloaded",
  [LifecycleState.Started]: "started",
  [LifecycleState.Quitting]: "quitting",
} as const satisfies Partial<Record<LifecycleState, string>>;

type StateEventData = {
  [
    K in keyof typeof STATE_EVENT_MAP
  ]: LifecycleEvents[(typeof STATE_EVENT_MAP)[K] & keyof LifecycleEvents];
};

export interface LifecycleService {
  readonly events: Emittery<LifecycleEvents>;
  currentState(): LifecycleState;
  setLifecycleState<K extends LifecycleState>(
    lifecycleState: K,
    ...args: K extends keyof StateEventData
      ? [undefined] extends [StateEventData[K]]
        ? [eventData?: StateEventData[K]]
        : [eventData: StateEventData[K]]
      : []
  ): void;
}

export function createLifecycleService(deps: {
  logger: Logger;
  events: Emittery<LifecycleEvents>;
}): LifecycleService {
  const { events } = deps;
  let state = LifecycleState.Starting;

  function setLifecycleState<K extends LifecycleState>(
    lifecycleState: K,
    ...args: K extends keyof StateEventData
      ? [undefined] extends [StateEventData[K]]
        ? [eventData?: StateEventData[K]]
        : [eventData: StateEventData[K]]
      : []
  ): void {
    state = lifecycleState;
    const event =
      STATE_EVENT_MAP[lifecycleState as keyof typeof STATE_EVENT_MAP];
    if (!event) return;
    events
      .emit(
        event as keyof LifecycleEvents,
        args[0] as LifecycleEvents[keyof LifecycleEvents]
      )
      .catch((e) => {
        deps.logger.error({ err: toError(e) }, `Lifecycle event emit error`);
      });
  }

  return { events, currentState: () => state, setLifecycleState };
}
