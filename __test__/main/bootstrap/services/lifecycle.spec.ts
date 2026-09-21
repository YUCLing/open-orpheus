import Emittery from "emittery";
import type { BrowserWindow } from "electron";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createLifecycleService,
  LifecycleState,
  type LifecycleEvents,
} from "@main/bootstrap/services/lifecycle";

function createService() {
  const logger = { error: vi.fn() } as unknown as Logger;
  const events = new Emittery<LifecycleEvents>();
  return {
    events,
    service: createLifecycleService({ logger, events }),
    logger,
  };
}

/** Emittery notifies listeners from a microtask. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createLifecycleService", () => {
  it("starts in the Starting state", () => {
    const { service } = createService();

    expect(service.currentState()).toBe(LifecycleState.Starting);
  });

  it("records the state it was given", () => {
    const { service } = createService();

    service.setLifecycleState(LifecycleState.Started);

    expect(service.currentState()).toBe(LifecycleState.Started);
  });

  it("emits the mapped event with the payload", async () => {
    const { service } = createService();
    const seen: [string, unknown][] = [];
    service.events.on("mainwindowcreated", (event) => {
      seen.push([event.name, event.data]);
    });

    const wnd = { id: 1 } as unknown as BrowserWindow;
    service.setLifecycleState(LifecycleState.MainWindowCreated, wnd);
    await flush();

    expect(seen).toEqual([["mainwindowcreated", wnd]]);
  });

  it("emits started with no payload", async () => {
    const { service } = createService();
    const seen: string[] = [];
    service.events.on("started", (event) => {
      seen.push(event.name);
    });

    service.setLifecycleState(LifecycleState.Started);
    await flush();

    expect(seen).toEqual(["started"]);
  });

  it("does not emit for states with no mapped event", async () => {
    const { service } = createService();
    const listener = vi.fn();
    for (const name of [
      "mainwindowcreated",
      "mainwindowloaded",
      "started",
      "quitting",
    ] as const) {
      service.events.on(name, listener);
    }

    service.setLifecycleState(LifecycleState.Quitting);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);

    service.setLifecycleState(LifecycleState.Starting);
    await flush();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.currentState()).toBe(LifecycleState.Starting);
  });

  it("logs a listener failure instead of throwing", async () => {
    const { service, logger } = createService();
    service.events.on("started", () => {
      throw new Error("listener blew up");
    });

    service.setLifecycleState(LifecycleState.Started);
    await flush();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(service.currentState()).toBe(LifecycleState.Started);
  });
});
