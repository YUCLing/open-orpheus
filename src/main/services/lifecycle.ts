import { app, type BrowserWindow } from "electron";
import Emittery from "emittery";
import type { Logger } from "pino";

import { toError } from "@shared/util";

export type StartupTask =
  | {
      type: "openFile";
      file: string;
    }
  | {
      type: "openUrl";
      url: string;
    };

export let startupTask: StartupTask | null = null;

export function setStartupTask(task: StartupTask) {
  if (startupTask !== null) return; // Task is already set, ignoring.
  startupTask = task;
}

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
  [K in keyof typeof STATE_EVENT_MAP]: LifecycleEvents[(typeof STATE_EVENT_MAP)[K] &
    keyof LifecycleEvents];
};

export interface LifecycleService {
  readonly events: Emittery<LifecycleEvents>;
  currentState(): LifecycleState;
  /**
   * Shutdown work is registered through the service so a consumer (and a spec)
   * receives the hooks instead of importing them — `bootstrap/shutdown.ts` used
   * to import them, which made its own module scope a registration side effect
   * and forced its spec to mock this module.
   */
  registerShutdownTask(task: ShutdownTask): void;
  registerShutdownFinalizer(finalizer: ShutdownFinalizer): void;
  setLifecycleState<K extends LifecycleState>(
    lifecycleState: K,
    ...args: K extends keyof StateEventData
      ? [undefined] extends [StateEventData[K]]
        ? [eventData?: StateEventData[K]]
        : [eventData: StateEventData[K]]
      : []
  ): void;
}

/**
 * Created here rather than inside a service: several modules subscribe at import
 * time, which is before any service exists. A bus is ambient context, not
 * installed state, so a module-level constant is the right shape for it.
 */
export const events = new Emittery<LifecycleEvents>();

/**
 * The application's lifecycle state, private to this module.
 *
 * Both accessors below are **always real**. A previous design kept `currentState`
 * and `setLifecycleState` as module-level slots that `bootstrap()` installed
 * later, with `Starting` and a no-op as placeholders until it did — which turned
 * a wiring mistake into a silently wrong answer. Here the state simply starts at
 * `Starting`, which *is* the truth before anyone moves it, and `setLifecycleState`
 * always sets it.
 */
let state: LifecycleState = LifecycleState.Starting;

/**
 * Where emit failures are reported, bound by {@link createLifecycleService}.
 *
 * Until then a failed emit is dropped. That is the only thing in this module
 * that depends on configuration — the state never does.
 */
let reportEmitFailure: ((error: unknown) => void) | undefined;

/** Bound by {@link createLifecycleService}; otherwise the real one is imported. */
let flushLogs: (() => void) | undefined;

export function currentState(): LifecycleState {
  return state;
}

export function setLifecycleState<K extends LifecycleState>(
  lifecycleState: K,
  ...args: K extends keyof StateEventData
    ? [undefined] extends [StateEventData[K]]
      ? [eventData?: StateEventData[K]]
      : [eventData: StateEventData[K]]
    : []
): void {
  state = lifecycleState;
  const event = STATE_EVENT_MAP[lifecycleState as keyof typeof STATE_EVENT_MAP];
  if (!event) return;
  events
    .emit(event as keyof LifecycleEvents, args[0] as LifecycleEvents[keyof LifecycleEvents])
    .catch((e) => reportEmitFailure?.(e));
}

/**
 * Binds error reporting and hands back the same API as an object, for consumers
 * that would rather receive it than import it.
 *
 * Called once by the composition root. The state is already live before it runs,
 * so there is no ordering requirement on this call and no placeholder to install.
 */
export function createLifecycleService(deps: {
  logger: Logger;
  /** Defaults to the real log flusher, imported lazily at shutdown. */
  flushLogs?: () => void;
}): LifecycleService {
  reportEmitFailure = (e) => deps.logger.error({ err: toError(e) }, `Lifecycle event emit error`);
  flushLogs = deps.flushLogs;
  return {
    events,
    currentState,
    setLifecycleState,
    registerShutdownTask,
    registerShutdownFinalizer,
  };
}

// --- Shutdown -------------------------------------------------------------
//
// Quitting and being signalled are the same shutdown, so both entry points
// drive one sequence and share one state machine: whichever arrives first runs
// the registered tasks, and the other waits for it or stops waiting.
//
// Two independent bounds keep a slow task from making the app unquittable:
// a per-task timeout stops one hung task from starving the tasks behind it,
// and a global deadline stops a run of slow tasks from making quit unbounded.

const SHUTDOWN_DEADLINE_MS = 5000;
const DEFAULT_TASK_TIMEOUT_MS = 1500;
const FINALIZER_TIMEOUT_MS = 1000;

export interface LifecycleOptions {
  /**
   * Where the shutdown sequence reports. Optional so a caller that has no
   * logger — the shutdown specs, for instance — can still install the
   * sequence. Nothing is imported here on purpose: this module is loaded by
   * unit tests that must not evaluate the pino transport, and the previous
   * `LOGGER` compile-time global is gone (P1-5).
   */
  logger?: Logger;
  /**
   * Upper bound on the whole shutdown sequence, in milliseconds.
   *
   * Overridable so the bounds below can be exercised by tests without waiting
   * out the real budget. This is not a user-facing setting.
   */
  shutdownDeadlineMs?: number;
  /** Default per-task timeout, in milliseconds. */
  taskTimeoutMs?: number;
  /**
   * Per-finalizer timeout, in milliseconds. Finalizers are outside the shutdown
   * deadline, so this is the only bound they have.
   */
  finalizerTimeoutMs?: number;
}

/**
 * Set by `installLifecycle`. Before that the sequence cannot run, so there is
 * nothing to report; the no-op keeps `logSkipped` and friends callable.
 */
let log: Pick<Logger, "warn" | "error"> = { warn() {}, error() {} };

let shutdownDeadlineMs = SHUTDOWN_DEADLINE_MS;
let defaultTaskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS;
let finalizerTimeoutMs = FINALIZER_TIMEOUT_MS;

export interface ShutdownTask {
  /** Stable identifier, used for logging only. */
  name: string;
  /**
   * The work to run. `signal` is aborted when this task's own timeout, or the
   * overall shutdown deadline, is reached, so tasks that own cancellable I/O
   * can stop it instead of being abandoned mid-flight.
   */
  run: (signal: AbortSignal) => void | Promise<void>;
  /** Defaults to `DEFAULT_TASK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

const shutdownTasks: ShutdownTask[] = [];
let shutdownState: "idle" | "running" | "done" = "idle";
let lifecycleInstalled = false;

/**
 * Register work to run when the app shuts down.
 *
 * Tasks run in reverse registration order, so a resource registered later is
 * torn down first.
 */
export function registerShutdownTask(task: ShutdownTask): void {
  shutdownTasks.push(task);
}

/**
 * A last action that must happen however the tasks went.
 *
 * The deadline above exists so that quitting stays bounded, which means a slow
 * task can skip the tasks behind it. For work that is the *point* of the
 * shutdown rather than cleanup — powering the machine off at the end of an
 * auto-exit countdown, say — being skipped silently turns the feature into a
 * lie, so it is registered here instead: finalizers run after every task and
 * after the log buffer is flushed, and the overall deadline does not apply to
 * them.
 */
export interface ShutdownFinalizer {
  /** Stable identifier, used for logging only. */
  name: string;
  /**
   * The work to run. Keep it quick and self-contained: everything else is
   * already done by this point, and it is bounded only by `finalizerTimeoutMs`.
   */
  run: () => void | Promise<void>;
}

const shutdownFinalizers: ShutdownFinalizer[] = [];

/**
 * Register a finalizer, described by {@link ShutdownFinalizer}.
 *
 * They run in reverse registration order, like the tasks.
 */
export function registerShutdownFinalizer(finalizer: ShutdownFinalizer): void {
  shutdownFinalizers.push(finalizer);
}

/**
 * Flush the log transport's buffer.
 *
 * Loaded lazily so that importing this module (which `window.ts` and several
 * unit tests do) does not evaluate the pino transport.
 */
async function flushLogBuffer(): Promise<void> {
  try {
    if (flushLogs !== undefined) {
      flushLogs();
      return;
    }
    // Lazy on purpose: importing the logger module evaluates the pino
    // transport, which `window.ts` and many unit tests have no use for. A
    // caller that would rather supply the flusher (a test asserting the flush
    // happened, say) passes one to `createLifecycleService`.
    const { flushLogs: realFlushLogs } = await import("../platform/logger");
    realFlushLogs();
  } catch {
    // Best effort: logging must never keep the app from exiting.
  }
}

function logSkipped(tasks: ShutdownTask[]): void {
  if (tasks.length === 0) return;
  log.warn({ tasks: tasks.map((task) => task.name) }, `Shutdown tasks skipped: deadline reached`);
}

/** Resolves when `signal` aborts, or immediately if it already has. */
function onceAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function runShutdownTasks(): Promise<void> {
  const deadline = AbortSignal.timeout(shutdownDeadlineMs);
  const startedAt = Date.now();
  const queue = [...shutdownTasks].reverse();

  for (let index = 0; index < queue.length; index++) {
    const task = queue[index];

    if (deadline.aborted) {
      logSkipped(queue.slice(index));
      break;
    }

    // Never let one task run past the overall deadline. When the remaining
    // budget is the smaller term the deadline is what ends this task, and the
    // log line below says so rather than blaming the task.
    const remaining = shutdownDeadlineMs - (Date.now() - startedAt);
    const timeoutMs = task.timeoutMs ?? defaultTaskTimeoutMs;
    const budget = Math.max(Math.min(timeoutMs, remaining), 0);
    // Composed so the task sees either bound. The per-task signal is fresh each
    // iteration, so a task that times out does not cancel the next one.
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(budget)]);

    try {
      // Racing on an explicit winner rather than inspecting the signal, so a
      // task that finishes as its timeout fires is not misreported. `race`
      // attaches handlers to the task promise, so a straggler that rejects
      // later cannot become an unhandled rejection.
      const outcome = await Promise.race([
        Promise.resolve(task.run(signal)).then(() => "done" as const),
        onceAborted(signal).then(() => "expired" as const),
      ]);

      if (outcome === "done") continue;

      if (deadline.aborted) {
        log.warn({ task: task.name }, `Shutdown task cut off by the shutdown deadline`);
        logSkipped(queue.slice(index + 1));
        break;
      }

      log.warn({ task: task.name, timeoutMs: budget }, `Shutdown task timed out`);
    } catch (e) {
      // One failing task must not skip the rest of the cleanup.
      log.error({ err: toError(e), task: task.name }, `Shutdown task failed`);
    }
  }

  // Last, so everything above is captured.
  await flushLogBuffer();

  // Whatever the tasks did — including using up the whole deadline — these still
  // run, because by now they are the only thing left that matters.
  await runShutdownFinalizers();
}

/**
 * Run every finalizer, whatever the tasks did.
 *
 * Each one gets `finalizerTimeoutMs` of its own rather than a share of the
 * shutdown deadline, which by now may be long gone: a finalizer that is skipped
 * is a promise the shutdown broke.
 */
async function runShutdownFinalizers(): Promise<void> {
  for (const finalizer of [...shutdownFinalizers].reverse()) {
    const signal = AbortSignal.timeout(finalizerTimeoutMs);

    try {
      const outcome = await Promise.race([
        Promise.resolve(finalizer.run()).then(() => "done" as const),
        onceAborted(signal).then(() => "expired" as const),
      ]);

      if (outcome === "expired") {
        log.warn({ finalizer: finalizer.name }, `Shutdown finalizer timed out`);
      }
    } catch (e) {
      // One failing finalizer must not stop the rest.
      log.error({ err: toError(e), finalizer: finalizer.name }, `Shutdown finalizer failed`);
    }
  }
}

function exitNow(code: number): void {
  // `app.exit` tears Chromium's own child processes down instead of leaving
  // them to be killed under us. Before `ready` it is not safe to assume, so
  // fall back to exiting the process directly.
  if (app.isReady()) {
    app.exit(code);
    return;
  }
  process.exit(code);
}

/**
 * Wire quitting and signals into the shutdown sequence. Idempotent.
 *
 * Call this as early as possible: it is what makes a signal arriving during
 * startup, before any task is registered, still exit with the right code.
 */
export function installLifecycle(options: LifecycleOptions = {}): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  log = options.logger ?? { warn() {}, error() {} };
  shutdownDeadlineMs = options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS;
  defaultTaskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  finalizerTimeoutMs = options.finalizerTimeoutMs ?? FINALIZER_TIMEOUT_MS;

  app.on("window-all-closed", () => {
    // Make sure we don't quit because of package download window being closed
    // before main window has started
    if (currentState() !== LifecycleState.Starting) app.quit();
  });

  app.on("before-quit", (event) => {
    // Final pass: the tasks have run, so let Electron close and quit.
    if (shutdownState === "done") return;

    event.preventDefault();
    if (shutdownState === "running") return; // Already shutting down.

    shutdownState = "running";
    // Before the first await, so window close vetoes are released and the
    // windows hide while the tasks run rather than after.
    setLifecycleState(LifecycleState.Quitting);
    void runShutdownTasks()
      .catch((e) => log.error({ err: toError(e) }, `Shutdown failed`))
      .finally(() => {
        shutdownState = "done";
        app.quit();
      });
  });

  const onSignal = (signal: NodeJS.Signals) => {
    const code = signal === "SIGINT" ? 130 : 143; // 128 + signal number

    if (shutdownState !== "idle") {
      // A second signal, or a signal while cleanup is already running: the
      // user is asking twice, so stop waiting for the tasks.
      exitNow(code);
      return;
    }

    shutdownState = "running";
    setLifecycleState(LifecycleState.Quitting);
    void runShutdownTasks()
      .catch((e) => log.error({ err: toError(e) }, `Shutdown failed`))
      .finally(() => exitNow(code));
  };

  // We expect the process MUST exit after these signals, so handle them first.
  process.prependListener("SIGINT", onSignal);
  process.prependListener("SIGTERM", onSignal);
  // Windows Ctrl+Break. `SIGTERM` is never delivered there, so this is the only
  // console signal a Windows user can send; harmless on other platforms.
  process.prependListener("SIGBREAK", onSignal);
}
