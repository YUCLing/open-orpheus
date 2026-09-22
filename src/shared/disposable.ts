/**
 * The teardown half of every registration (§3.3).
 *
 * A registrar returns one of these instead of deciding for itself when its
 * subscription, IPC channel or listener should go away. That is what lets a
 * caller own a registration it did not write — which is what plugin teardown
 * and dev hot-reload need, and what makes a leak test expressible.
 *
 * Lives in `src/shared` rather than in `bootstrap/types.ts` so the preload and
 * bridge planes can reach it too. It imports nothing, so it stays safe for the
 * sandboxed preload.
 */
export interface Disposable {
  dispose(): void;
}

/**
 * Wrap a teardown function — Emittery's unlisten, Electron's `removeHandler`,
 * `clearInterval` — as a `Disposable`.
 *
 * Disposing twice is a no-op, so a registration may be torn down both by its
 * own trigger and by whoever owns it without running teardown twice.
 */
export function toDisposable(teardown: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
    },
  };
}

/** For a registration that installs nothing to release. */
export function noopDisposable(): Disposable {
  return { dispose() {} };
}

/**
 * Compose registrations into one handle, torn down in reverse registration
 * order: a later registration may depend on an earlier one, so it falls first.
 *
 * Every member is disposed even if one of them throws, so a failing teardown
 * cannot strand the registrations after it; the first error is rethrown once
 * the rest have run.
 */
export function combineDisposables(...disposables: Disposable[]): Disposable {
  const ordered = [...disposables].reverse();
  return toDisposable(() => {
    let failure: unknown;
    for (const disposable of ordered) {
      try {
        disposable.dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  });
}
