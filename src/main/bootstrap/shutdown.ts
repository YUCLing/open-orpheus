import type { DbusClient } from "@open-orpheus/dbus";
import os from "node:os";

import type { LifecycleService } from "../services/lifecycle";
import { toError } from "@shared/util";

export enum ScheduleShutdownStatus {
  /** The requested state is now in effect. */
  Ok,
  /** This platform, or the system, cannot schedule a shutdown. */
  NotAvailable,
  /** The requested state already held, so nothing changed. */
  AlreadySet,
  /**
   * Another application owns the system's shutdown schedule. Only logind lets us
   * see one: Windows cannot report a pending shutdown, so a request that clashes
   * with one it cannot report fails at the deadline instead.
   */
  ManagedExternally,
  /** The request could not be completed (e.g. the bus is unreachable). */
  Failed,
}

/**
 * One platform's way of scheduling a machine shutdown.
 *
 * The two platforms could hardly differ more: Linux hands the deadline to
 * logind, which then keeps the schedule independently of this process, while
 * Windows cannot report or retime a pending shutdown at all — there the
 * countdown in `calls/os.ts` *is* the schedule, and all this file does is check
 * that the machine can be powered off and, at the end, power it off.
 *
 * Everything platform-specific lives in one of the backends below, so the
 * wiring never has to ask which platform it is running on.
 */
interface ShutdownBackend {
  /**
   * Put the state `time` asks for in effect, or the one in effect now when it
   * is omitted.
   */
  apply(time?: Date): Promise<ScheduleShutdownStatus>;
  /** Whether this app currently owns a schedule. */
  hasSchedule(): boolean;
  /**
   * The app's own countdown reached zero, so the quit it started is running.
   *
   * Only platforms whose countdown is the schedule itself implement this; where
   * the system holds the schedule (logind), the powering down is already dealt
   * with elsewhere and it is left out.
   */
  afterCountdown?(): Promise<void>;
}

// #region Linux: logind keeps the schedule, this process only drives it
/** The logind manager object, shared by every call below. */
const LOGIND_MANAGER = {
  destination: "org.freedesktop.login1",
  path: "/org/freedesktop/login1",
  interfaceName: "org.freedesktop.login1.Manager",
} as const;

let dbusClient: DbusClient | null = null;

/**
 * The shutdown logind reports for this app — microseconds since the epoch, the
 * unit logind uses — or `null` when the schedule is not ours.
 */
let logindSchedule: number | null = null;

async function getClient(): Promise<DbusClient> {
  if (!dbusClient) {
    dbusClient = new (await import("@open-orpheus/dbus")).DbusClient("system");
  }
  return dbusClient;
}

/**
 * Mirrors logind's own schedule so the app can tell its schedule from somebody
 * else's, and can cancel the one it owns.
 */
const linuxBackend: ShutdownBackend = {
  async apply(time) {
    // Client creation is inside the guarded region: connecting to the system bus
    // can fail (no bus, sandbox denial), which must become a failure status, not
    // a rejected promise that leaves the caller without a reply.
    let client: DbusClient;
    try {
      client = await getClient();
    } catch (err) {
      LOGGER.warn({ err: toError(err) }, "Failed to connect to the system bus");
      return ScheduleShutdownStatus.Failed;
    }

    try {
      const [canPoweroffRes, scheduledShutdownRes] = await Promise.all([
        client.call({ ...LOGIND_MANAGER, method: "CanPowerOff" }),
        client.getProperty({ ...LOGIND_MANAGER, name: "ScheduledShutdown" }),
      ]);
      const canPoweroff = canPoweroffRes.body[0] as string;
      if (canPoweroff !== "yes" && canPoweroff !== "challenge") {
        // System is not available for shutdown.
        return ScheduleShutdownStatus.NotAvailable;
      }
      const systemSchedule = scheduledShutdownRes.value as [string | "", number];
      // The shutdown schedule isn't managed by us.
      if (
        systemSchedule[0] &&
        (systemSchedule[0] !== "poweroff" || systemSchedule[1] !== logindSchedule)
      ) {
        logindSchedule = null;
        return ScheduleShutdownStatus.ManagedExternally;
      }
      if (time === undefined) {
        if (logindSchedule === null) return ScheduleShutdownStatus.AlreadySet;
        await client.call({
          ...LOGIND_MANAGER,
          method: "CancelScheduledShutdown",
        });
        logindSchedule = null;
      } else {
        // logind counts in microseconds; the app hands us milliseconds.
        const shutdownTime = time.valueOf() * 1000;
        if (shutdownTime === logindSchedule) return ScheduleShutdownStatus.AlreadySet;
        await client.call({
          ...LOGIND_MANAGER,
          method: "ScheduleShutdown",
          signature: "st",
          body: ["poweroff", shutdownTime],
        });
        logindSchedule = shutdownTime;
      }
    } catch (err) {
      // The system refused the request (or it could not be delivered). Report it
      // so the caller knows the schedule is not what it asked for.
      LOGGER.warn({ err: toError(err), time }, "Failed to update shutdown schedule");
      return ScheduleShutdownStatus.Failed;
    }
    return ScheduleShutdownStatus.Ok;
  },

  hasSchedule: () => logindSchedule !== null,
};
// #endregion

// #region Windows: the countdown is the schedule, this process powers off
/** Text Windows shows while it shuts down; the countdown itself is ours. */
const WINDOWS_SHUTDOWN_MESSAGE = "Open Orpheus 定时关机";

/**
 * Whether Windows closes applications with unsaved changes instead of letting
 * them block the shutdown. `shutdown /s /t` implies the same, and a grace period
 * would leave the machine on the "apps are preventing shutdown" screen; the
 * Linux path (logind `poweroff`) does not wait for applications either.
 */
const WINDOWS_FORCE_CLOSE_APPS = true;

/**
 * The shutdown time (milliseconds since the epoch) the countdown aims at, or
 * `null` when this app has no countdown of its own.
 */
let windowsSchedule: number | null = null;

/**
 * The Windows system module, loaded on first use: it is a Windows-only optional
 * dependency, so importing it on any other platform would fail outright.
 */
let systemModule: typeof import("@open-orpheus/system-win32") | null = null;

async function getSystemModule(): Promise<typeof import("@open-orpheus/system-win32")> {
  systemModule ??= await import("@open-orpheus/system-win32");
  return systemModule;
}

/**
 * Called when the countdown's own power-off was refused, so that the layer which
 * owns user-facing text can say the machine is staying on. Nothing else can: by
 * then this app is quitting and has no window left to say it in.
 */
let reportPowerOffFailure: (() => void) | null = null;

/** Provide that handler. `calls/os.ts` is the only caller. */
export function setPowerOffFailureHandler(handler: () => void): void {
  reportPowerOffFailure = handler;
}

/**
 * Windows cannot report which shutdown is pending and cannot retime one, so
 * nothing here is registered with the system: the backend remembers the
 * countdown, checks that the machine can be powered off at all, and powers it
 * off once the countdown is done.
 */
const win32Backend: ShutdownBackend = {
  async apply(time) {
    if (time === undefined) {
      if (windowsSchedule === null) return ScheduleShutdownStatus.AlreadySet;
      // Nothing was registered with the system, so cancelling is bookkeeping only.
      windowsSchedule = null;
      return ScheduleShutdownStatus.Ok;
    }
    if (time.valueOf() === windowsSchedule) return ScheduleShutdownStatus.AlreadySet;

    // The caller has already dropped the countdown it had (see `calls/os.ts`), so
    // a failed arm must not leave that older one in place: the machine would go
    // down at a time the user is about to be told will not happen.
    windowsSchedule = null;

    let system: typeof import("@open-orpheus/system-win32");
    try {
      system = await getSystemModule();
    } catch (err) {
      LOGGER.warn({ err: toError(err) }, "Failed to load the Windows system module");
      return ScheduleShutdownStatus.NotAvailable;
    }

    try {
      // Report a machine that cannot be powered off now, while the user is still
      // here to read it, instead of failing silently at the deadline.
      if (!system.canShutdown()) return ScheduleShutdownStatus.NotAvailable;
      windowsSchedule = time.valueOf();
    } catch (err) {
      LOGGER.warn({ err: toError(err), time }, "Failed to check the Windows shutdown privilege");
      return ScheduleShutdownStatus.Failed;
    }
    return ScheduleShutdownStatus.Ok;
  },

  hasSchedule: () => windowsSchedule !== null,

  /** The countdown reaching zero is the shutdown, so ask for it now. */
  async afterCountdown() {
    if (windowsSchedule === null) return;
    try {
      const system = await getSystemModule();
      system.shutdownNow(WINDOWS_SHUTDOWN_MESSAGE, WINDOWS_FORCE_CLOSE_APPS);
    } catch (err) {
      LOGGER.warn({ err: toError(err) }, "Failed to power off after the scheduled shutdown");
      // The machine is staying on although the user asked for it to go down, so
      // report that while there is still a process to report it from.
      reportPowerOffFailure?.();
    }
  },
};
// #endregion

// #region Wiring: the same shell around either backend
/** The backend for the platform this process runs on, if it has one. */
function selectBackend(): ShutdownBackend | null {
  switch (os.platform()) {
    case "linux":
      return linuxBackend;
    case "win32":
      return win32Backend;
    default:
      return null;
  }
}

const backend = selectBackend();

/** Whether this app owns a scheduled shutdown (or is busy creating one). */
export function hasManagedScheduledShutdown(): boolean {
  return (backend?.hasSchedule() ?? false) || requestsInFlight > 0;
}

// Requests are serialized so that a set and a cancel complete in the order they
// were issued. Otherwise a cancel that is issued while an earlier set is still
// on the bus can answer first, and the set then reactivates the schedule the
// user just cancelled.
let pendingRequest: Promise<unknown> = Promise.resolve();
let requestsInFlight = 0;

function enqueue<T>(request: () => Promise<T>): Promise<T> {
  requestsInFlight++;
  const result = pendingRequest.then(request, request);
  const settled = () => {
    requestsInFlight--;
  };
  result.then(settled, settled);
  // Keep the chain alive whatever the outcome of this request.
  pendingRequest = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Set the machine shutdown this app manages, or cancel it when `time` is
 * omitted.
 *
 * Requests run one at a time, in the order they arrive, so the last request
 * always wins even while an earlier one is still waiting on the system bus.
 * Failures are reported as {@link ScheduleShutdownStatus.Failed} rather than
 * rejected, so callers (including IPC handlers) always get an answer.
 */
export function setScheduledShutdown(time?: Date): Promise<ScheduleShutdownStatus> {
  return enqueue(() => applyScheduledShutdown(time));
}

async function applyScheduledShutdown(time?: Date): Promise<ScheduleShutdownStatus> {
  if (!backend) return ScheduleShutdownStatus.NotAvailable;
  return backend.apply(time);
}

/**
 * Set once the in-app countdown reaches zero: the shutdown that follows is the
 * intended outcome and must survive the quit the timer starts.
 */
let keepScheduleOnExit = false;

/** Mark that the pending quit is performing the scheduled shutdown. */
export function keepScheduledShutdownOnExit(): void {
  keepScheduleOnExit = true;
}

/** The hooks this module needs; the composition root supplies them. */
export type ShutdownWiring = Pick<
  LifecycleService,
  "registerShutdownTask" | "registerShutdownFinalizer"
>;

/**
 * Register this module's shutdown work.
 *
 * Called by the composition root rather than run as an import side effect: an
 * import that registers is invisible wiring, and it made the module unusable
 * without the real lifecycle module (which pulls Electron in).
 */
export function registerShutdownWork(lifecycle: ShutdownWiring): void {
  // A normal quit must not leave the machine set to power off. Only the timer
  // above keeps the schedule; every other exit cancels the schedule this app
  // owns, so quitting early keeps the machine on.
  lifecycle.registerShutdownTask({
    name: "scheduled-shutdown",
    timeoutMs: 1500,
    run: async () => {
      // The quit a completed countdown started is performing that shutdown, so
      // this must not cancel it.
      if (keepScheduleOnExit) return;
      // Nothing to do when this app has no schedule (and none is being created).
      if (!hasManagedScheduledShutdown()) return;
      const status = await setScheduledShutdown();
      if (status !== ScheduleShutdownStatus.Ok && status !== ScheduleShutdownStatus.AlreadySet) {
        LOGGER.warn({ status }, "Failed to cancel the scheduled shutdown on exit");
      }
    },
  });

  // The power-off a completed countdown owes is the point of that quit rather than
  // part of the cleanup, so it is a finalizer and not a task: the cleanup tasks
  // exhausting their deadline must not leave the machine on while this app exits.
  lifecycle.registerShutdownFinalizer({
    name: "scheduled-shutdown-poweroff",
    run: async () => {
      if (keepScheduleOnExit) await backend?.afterCountdown?.();
    },
  });
}
// #endregion
