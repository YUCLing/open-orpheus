import { ipcRenderer } from "electron";
import type { LogFn } from "pino";

type Bindings = Record<string, unknown>;
/** `child()` factory returned by the facade. */
type ChildFactory = (bindings: Bindings) => Facade;
/** The facade surface: a log method per level, plus `child(bindings)`. */
type Facade = Record<string, LogFn | ChildFactory>;

/**
 * Build a `LogFn` that forwards a log entry to the main process over IPC
 * (`logger.log`), where the real pino logger in `src/main/logger.ts` handles
 * it. When `bindings` is present, the main process logs through a pino child
 * logger carrying those fields (e.g. `name`, `call`).
 */
function forward(level: string, bindings: Bindings | undefined): LogFn {
  return (...args: Parameters<LogFn>) => {
    ipcRenderer.send("logger.log", level, bindings, ...args);
  };
}

/**
 * Logger facade for the preload (renderer) side.
 *
 * Unlike the main process, the preload cannot write logs to disk directly, so
 * it exposes a Proxy that mirrors the pino logger surface. Accessing any
 * property (e.g. `LOGGER.info`, `LOGGER.warn`) returns a {@link LogFn} that
 * forwards the log entry to the main process over IPC (`logger.log`), where
 * the real pino logger in `src/main/logger.ts` handles it.
 *
 * `child(bindings)` returns another facade that captures the bindings and
 * applies them to every forwarded entry, so the compile-time injected
 * `_logger.child({ name: "..." })` calls (see `build/vite-plugins/LoggerPlugin.ts`) work
 * in the preload too — the injected binding is a real logger object instead
 * of `undefined`.
 */
function createFacade(bindings: Bindings | undefined): Facade {
  const child: ChildFactory = (childBindings) =>
    createFacade({ ...bindings, ...childBindings });

  return new Proxy(Object.create(null) as Facade, {
    get: (_target, level: string) =>
      level === "child" ? child : forward(level, bindings),
  });
}

const logger = createFacade(undefined);

export default logger;
