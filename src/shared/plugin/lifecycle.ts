/**
 * Generic per-realm plugin lifecycle.
 *
 * Desired state is persisted intent. Runtime state is the observed truth about
 * one realm instance. The reconciler serializes operations: a single
 * activation or cleanup runs at a time, and timeouts are reported rather than
 * starting overlapping work that the host cannot actually cancel.
 */

/** @internal */
export interface PluginDesiredState {
  enabled: boolean;
  revision: number;
}

/**
 * In-process lifecycle state names.
 *
 * Deliberately separate from the manager contract: the contract enums are
 * `@internal` and stripped from the published SDK, so a cross-module reference
 * would leave a dangling import. The serializer maps these values onto the
 * IPC-facing enums.
 */
/** @internal */
export enum LifecycleStateKind {
  Stopped = "stopped",
  Starting = "starting",
  Running = "running",
  Stopping = "stopping",
  Failed = "failed",
  Hung = "hung",
  Abandoned = "abandoned",
  Disposed = "disposed",
}

/** @internal */
export enum LifecycleFailureStage {
  Load = "load",
  Activate = "activate",
  Deactivate = "deactivate",
}

/** @internal */
export enum LifecycleAbandonReason {
  RealmDestroyed = "realm-destroyed",
  ShutdownDeadline = "shutdown-deadline",
}

/** @internal */
export enum PluginCleanupReason {
  Disabled = "disabled",
  Retry = "retry",
  Shutdown = "shutdown",
}

/** @internal */
interface RuntimeStateBase {
  desiredRevision: number;
}

/** @internal */
export type LifecycleRuntimeState<Module> =
  | ({ kind: LifecycleStateKind.Stopped } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Starting;
      attempt: number;
      startedAt: number;
      timedOut: boolean;
    } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Running;
      attempt: number;
      module: Module;
    } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Stopping;
      attempt: number;
      module: Module;
      reason: PluginCleanupReason;
    } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Failed;
      attempt: number;
      stage: LifecycleFailureStage;
      error: unknown;
      module?: Module;
      retryable: boolean;
    } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Hung;
      attempt: number;
      stage: LifecycleFailureStage;
      since: number;
      module?: Module;
    } & RuntimeStateBase)
  | ({
      kind: LifecycleStateKind.Abandoned;
      attempt: number;
      stage: LifecycleFailureStage;
      reason: LifecycleAbandonReason;
    } & RuntimeStateBase)
  | ({ kind: LifecycleStateKind.Disposed } & RuntimeStateBase);

/** @internal */
export enum PluginDisposeStatus {
  Stopped = "stopped",
  CleanupFailed = "cleanup-failed",
  Abandoned = "abandoned",
}

/** @internal */
export interface PluginDisposeResult {
  status: PluginDisposeStatus;
}

/** @internal */
export class LifecycleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleTimeoutError";
  }
}

/** @internal */
export interface LifecycleAdapter<Module> {
  load(): Promise<Module>;
  activate(module: Module): void | Promise<void>;
  deactivate(module: Module): void | Promise<void>;
}

/** @internal */
export interface LifecycleSnapshot<Module> {
  desired: PluginDesiredState;
  state: LifecycleRuntimeState<Module>;
  attempt: number;
  module?: Module;
  error?: unknown;
}

/** @internal */
export interface LifecycleOptions<Module> {
  adapter: LifecycleAdapter<Module>;
  /** Soft activation and cleanup deadline. */
  timeoutMs?: number;
  onChange?: (snapshot: LifecycleSnapshot<Module>) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** @internal */
export class RealmLifecycle<Module> {
  private desired: PluginDesiredState = { enabled: false, revision: 0 };
  private state: LifecycleRuntimeState<Module> = {
    kind: LifecycleStateKind.Stopped,
    desiredRevision: 0,
  };
  private module: Module | undefined;
  private attempt = 0;
  private error: unknown;
  private activation: Promise<void> | undefined;
  private cleanupTask: Promise<void> | undefined;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private pendingKick = false;
  private retryRequested = false;
  private cleanupRetryRequested = false;
  private disposed = false;

  private readonly adapter: LifecycleAdapter<Module>;
  private readonly timeoutMs: number;
  private readonly onChange?: (snapshot: LifecycleSnapshot<Module>) => void;
  private readonly listeners = new Set<(snapshot: LifecycleSnapshot<Module>) => void>();

  constructor(options: LifecycleOptions<Module>) {
    this.adapter = options.adapter;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onChange = options.onChange;
  }

  get snapshot(): LifecycleSnapshot<Module> {
    return {
      desired: this.desired,
      state: this.state,
      attempt: this.attempt,
      module: this.module,
      error:
        this.state.kind === LifecycleStateKind.Failed ? this.state.error : this.error,
    };
  }

  get loadedModule(): Module | undefined {
    return this.module;
  }

  get desiredState(): PluginDesiredState {
    return this.desired;
  }

  /** Apply a committed desired state. Older revisions are ignored. */
  applyDesiredState(next: PluginDesiredState): void {
    if (this.disposed) return;
    if (next.revision < this.desired.revision) return;
    const changed = next.enabled !== this.desired.enabled;
    this.desired = next;
    if (changed) this.retryRequested = false;
    // A disable command also re-attempts a previously failed cleanup.
    if (!next.enabled) this.cleanupRetryRequested = true;
    this.kick();
  }

  enable(revision = this.desired.revision + 1): void {
    this.applyDesiredState({ enabled: true, revision });
  }

  disable(revision = this.desired.revision + 1): void {
    this.applyDesiredState({ enabled: false, revision });
  }

  /** Ask for a fresh attempt without changing desired state. */
  retry(): void {
    if (this.disposed || !this.desired.enabled) return;
    this.retryRequested = true;
    this.kick();
  }

  /** Resolve once the predicate matches, or reject on a wait timeout. */
  waitFor(
    predicate: (snapshot: LifecycleSnapshot<Module>) => boolean,
    waitMs = this.timeoutMs + 1000
  ): Promise<LifecycleSnapshot<Module>> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const listener = (snapshot: LifecycleSnapshot<Module>) => {
        if (!predicate(snapshot)) return;
        this.listeners.delete(listener);
        clearTimeout(timer);
        resolve(snapshot);
      };
      timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("Timed out waiting for plugin lifecycle state"));
      }, waitMs);
      this.listeners.add(listener);
      listener(this.snapshot);
    });
  }

  async dispose(deadlineMs = this.timeoutMs): Promise<PluginDisposeResult> {
    this.disposed = true;
    this.clearTimeout();
    this.desired = { enabled: false, revision: this.desired.revision };
    const deadline = Date.now() + deadlineMs;
    const remaining = () => Math.max(0, deadline - Date.now());

    if (this.activation) {
      if (!(await settlesWithin(this.activation, remaining()))) {
        this.abandon(LifecycleFailureStage.Activate);
        return { status: PluginDisposeStatus.Abandoned };
      }
      this.activation = undefined;
    }

    const cleanup =
      this.cleanupTask ??
      (this.module ? this.runCleanup(PluginCleanupReason.Shutdown) : undefined);
    if (cleanup) {
      if (!(await settlesWithin(cleanup, remaining()))) {
        this.abandon(LifecycleFailureStage.Deactivate);
        return { status: PluginDisposeStatus.Abandoned };
      }
    }

    if (this.module) return { status: PluginDisposeStatus.CleanupFailed };
    this.setState({
      kind: LifecycleStateKind.Disposed,
      desiredRevision: this.desired.revision,
    });
    return { status: PluginDisposeStatus.Stopped };
  }

  private kick(): void {
    if (this.disposed) return;
    if (this.running) {
      this.pendingKick = true;
      return;
    }
    this.running = this.reconcile().finally(() => {
      this.running = null;
      if (this.pendingKick) {
        this.pendingKick = false;
        this.kick();
      }
    });
    void this.running.catch(() => {});
  }

  private async reconcile(): Promise<void> {
    while (!this.disposed) {
      const state = this.state;

      if (this.desired.enabled) {
        if (
          state.kind === LifecycleStateKind.Running ||
          state.kind === LifecycleStateKind.Starting ||
          state.kind === LifecycleStateKind.Stopping ||
          state.kind === LifecycleStateKind.Hung ||
          state.kind === LifecycleStateKind.Abandoned ||
          state.kind === LifecycleStateKind.Disposed
        ) {
          return;
        }
        if (state.kind === LifecycleStateKind.Failed) {
          if (!this.retryRequested) return;
          if (this.module) {
            await this.runCleanup(PluginCleanupReason.Retry);
            continue;
          }
          this.startActivation();
          return;
        }
        if (state.kind === LifecycleStateKind.Stopped) {
          this.startActivation();
          return;
        }
        return;
      }

      // Desired disabled. Activation and cleanup are serialized, so a state
      // with an in-flight operation only waits for that operation to settle.
      if (
        state.kind === LifecycleStateKind.Starting ||
        state.kind === LifecycleStateKind.Hung
      ) {
        return;
      }
      if (state.kind === LifecycleStateKind.Stopping) {
        if (this.module) {
          await this.runCleanup(state.reason);
          continue;
        }
        return;
      }
      if (
        state.kind === LifecycleStateKind.Failed &&
        state.stage === LifecycleFailureStage.Deactivate
      ) {
        if (!this.cleanupRetryRequested) return;
        await this.runCleanup(PluginCleanupReason.Disabled);
        continue;
      }
      if (this.module) {
        await this.runCleanup(PluginCleanupReason.Disabled);
        continue;
      }
      if (state.kind !== LifecycleStateKind.Stopped) {
        this.setState({
          kind: LifecycleStateKind.Stopped,
          desiredRevision: this.desired.revision,
        });
      }
      return;
    }
  }

  private startActivation(): void {
    const attempt = ++this.attempt;
    this.retryRequested = false;
    this.error = undefined;
    this.setState({
      kind: LifecycleStateKind.Starting,
      attempt,
      startedAt: Date.now(),
      timedOut: false,
      desiredRevision: this.desired.revision,
    });

    this.timeout = setTimeout(() => this.onActivationTimeout(attempt), this.timeoutMs);

    const activation = (async () => {
      const module = await this.adapter.load();
      if (this.disposed || attempt !== this.attempt) {
        try {
          await this.adapter.deactivate(module);
        } catch {
          // A stale activation is best-effort cleanup only.
        }
        return;
      }
      this.module = module;
      await this.adapter.activate(module);
    })();

    this.activation = activation;
    void activation.then(
      () => this.settleActivation(attempt),
      (error: unknown) => this.settleActivation(attempt, error)
    );
  }

  private onActivationTimeout(attempt: number): void {
    if (this.disposed || attempt !== this.attempt) return;
    if (this.state.kind !== LifecycleStateKind.Starting) return;

    this.timeout = null;
    this.error = new LifecycleTimeoutError(
      `Plugin activation timed out after ${this.timeoutMs}ms`
    );
    this.setState({
      kind: LifecycleStateKind.Hung,
      attempt,
      stage: this.module ? LifecycleFailureStage.Activate : LifecycleFailureStage.Load,
      since: Date.now(),
      module: this.module,
      desiredRevision: this.desired.revision,
    });
  }

  private async settleActivation(attempt: number, error?: unknown): Promise<void> {
    if (attempt !== this.attempt) return;
    this.clearTimeout();
    this.activation = undefined;

    if (this.disposed) {
      if (this.module) void this.runCleanup(PluginCleanupReason.Shutdown);
      return;
    }

    if (error !== undefined) {
      this.error = error;
      const stage: LifecycleFailureStage = this.module
        ? LifecycleFailureStage.Activate
        : LifecycleFailureStage.Load;
      if (this.module) {
        await this.runCleanup(PluginCleanupReason.Disabled);
        if (this.module) {
          // Cleanup failed; keep that failure, which owns the retained module.
          this.kick();
          return;
        }
      }
      this.error = error;
      if (!this.desired.enabled) {
        this.setState({
          kind: LifecycleStateKind.Stopped,
          desiredRevision: this.desired.revision,
        });
      } else {
        this.setState({
          kind: LifecycleStateKind.Failed,
          attempt,
          stage,
          error,
          retryable: true,
          desiredRevision: this.desired.revision,
        });
      }
      this.kick();
      return;
    }

    if (!this.desired.enabled) {
      if (this.module) {
        this.setState({
          kind: LifecycleStateKind.Stopping,
          attempt,
          module: this.module,
          reason: PluginCleanupReason.Disabled,
          desiredRevision: this.desired.revision,
        });
        this.kick();
      } else {
        this.setState({
          kind: LifecycleStateKind.Stopped,
          desiredRevision: this.desired.revision,
        });
      }
      return;
    }

    if (!this.module) {
      this.setState({
        kind: LifecycleStateKind.Failed,
        attempt,
        stage: LifecycleFailureStage.Load,
        error: new Error("Plugin activation finished without a module"),
        retryable: true,
        desiredRevision: this.desired.revision,
      });
      return;
    }

    this.error = undefined;
    this.setState({
      kind: LifecycleStateKind.Running,
      attempt,
      module: this.module,
      desiredRevision: this.desired.revision,
    });
  }

  private runCleanup(reason: PluginCleanupReason): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    this.cleanupRetryRequested = false;

    const task = (async () => {
      const module = this.module;
      if (!module) {
        if (this.disposed) return;
        this.setState({
          kind: LifecycleStateKind.Stopped,
          desiredRevision: this.desired.revision,
        });
        return;
      }

      this.setState({
        kind: LifecycleStateKind.Stopping,
        attempt: this.attempt,
        module,
        reason,
        desiredRevision: this.desired.revision,
      });

      const outcome = await settlesWithinValue(
        Promise.resolve()
          .then(() => this.adapter.deactivate(module))
          .then(
            () => ({ kind: "done" as const }),
            (error: unknown) => ({ kind: "error" as const, error })
          ),
        this.timeoutMs
      );

      if (outcome === "timeout") {
        this.retryRequested = false;
        this.error = new LifecycleTimeoutError(
          `Plugin cleanup timed out after ${this.timeoutMs}ms`
        );
        this.setState({
          kind: LifecycleStateKind.Hung,
          attempt: this.attempt,
          stage: LifecycleFailureStage.Deactivate,
          since: Date.now(),
          module,
          desiredRevision: this.desired.revision,
        });
        return;
      }

      if (outcome.kind === "error") {
        this.retryRequested = false;
        this.error = outcome.error;
        this.setState({
          kind: LifecycleStateKind.Failed,
          attempt: this.attempt,
          stage: LifecycleFailureStage.Deactivate,
          error: outcome.error,
          module,
          retryable: this.desired.enabled,
          desiredRevision: this.desired.revision,
        });
        return;
      }

      this.module = undefined;
      this.error = undefined;
      this.setState({
        kind: this.disposed
          ? LifecycleStateKind.Disposed
          : LifecycleStateKind.Stopped,
        desiredRevision: this.desired.revision,
      });
    })();

    this.cleanupTask = task;
    void task
      .finally(() => {
        if (this.cleanupTask === task) this.cleanupTask = undefined;
      })
      .catch(() => {});

    return task;
  }

  private abandon(stage: LifecycleFailureStage): void {
    this.setState({
      kind: LifecycleStateKind.Abandoned,
      attempt: this.attempt,
      stage,
      reason: LifecycleAbandonReason.ShutdownDeadline,
      desiredRevision: this.desired.revision,
    });
  }

  private clearTimeout(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  private setState(state: LifecycleRuntimeState<Module>): void {
    this.state = state;
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
    this.onChange?.(snapshot);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

async function settlesWithinValue<T extends object | "timeout">(
  promise: Promise<T>,
  ms: number
): Promise<T | "timeout"> {
  if (ms <= 0) return "timeout";
  return Promise.race([promise, delay(ms).then(() => "timeout" as const)]);
}
