import { BrowserWindow } from "electron";
import Emittery from "emittery";

export type LifecycleEvents = {
  /**
   * This event fires when main window has just been created, and the content
   * is not loaded yet.
   *
   * Note that in this event, `mainWindow` is not set yet, but you can get it
   * in the event data.
   */
  mainwindowcreated: BrowserWindow;
  /**
   * This event fires when app is fully started and ready.
   *
   * At this point, `mainWindow` should be fully available to use, if not,
   * something's seriously wrong.
   */
  started: undefined;
  quitting: undefined;
};

export const events = new Emittery<LifecycleEvents>();

export let started = false;
export let quitting = false;

export function markStarted() {
  started = true;
  events.emit("started");
}

export function markQuitting() {
  quitting = true;
  events.emit("quitting");
}
