/**
 * Generic per-realm plugin lifecycle.
 *
 * Desired state is the persisted intent. Actual state is driven by a small
 * reconciler: every activation/cleanup has a generation, a soft timeout keeps
 * ownership of the in-flight activation, and a late completion may clean up but
 * cannot resurrect a plugin that is no longer desired.
 */

export enum LifecyclePhase {
  Disabled = "disabled",
  Enabling = "enabling",
  Active = "active",
  Disabling = "disabling",
  Failed = "failed",
}

export class LifecycleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleTimeoutError";
  }
}

export interface LifecycleAdapter<Module> {
  load(): Promise<Module>;
  activate(module: Module): void | Promise<void>;
  deactivate(module: Module): void | Promise<void>;
}

export interface LifecycleSnapshot<Module> {
  phase: LifecyclePhase;
  desired: boolean;
  generation: number;
  timedOut: boolean;
  retryRequired: boolean;
  cleanupPending: boolean;
  module?: Module;
  error?: unknown;
}

export interface LifecycleOptions<Module> {
  adapter: LifecycleAdapter<Module>;
  /** Soft activation deadline. The activation is retained after this expires. */
  timeoutMs?: number;
  onChange?: (snapshot: LifecycleSnapshot<Module>) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class RealmLifecycle<Module> {
  private phase = LifecyclePhase.Disabled;
  private desired = false;
  private module: Module | undefined;
  private generation = 0;
  private timedOut = false;
  private retryRequired = false;
  private cleanupPending = false;
  private error: unknown;
  private activation: Promise<void> | undefined;
  private cleanupTask: Promise<void> | null = null;
  private orphan: Promise<void> | undefined;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private pendingKick = false;
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
      phase: this.phase,
      desired: this.desired,
      generation: this.generation,
      timedOut: this.timedOut,
      retryRequired: this.retryRequired,
      cleanupPending: this.cleanupPending,
      module: this.module,
      error: this.error,
    };
  }

  /** Whether another plugin may import this plugin's exports right now. */
  get canImport(): boolean {
    if (!this.desired) return false;
    return (
      this.phase === LifecyclePhase.Disabled ||
      this.phase === LifecyclePhase.Enabling ||
      this.phase === LifecyclePhase.Active
    );
  }

  get loadedModule(): Module | undefined {
    return this.module;
  }

  enable(): void {
    if (this.disposed) return;
    this.desired = true;
    this.retryRequired = false;
    this.kick();
  }

  disable(): void {
    if (this.disposed) return;
    this.desired = false;
    this.kick();
  }

  retry(): void {
    if (this.disposed || !this.desired) return;
    this.retryRequired = false;
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

  async dispose(deadlineMs = this.timeoutMs): Promise<void> {
    this.disposed = true;
    this.desired = false;
    this.clearTimeout();
    const activation = this.activation;
    if (activation) {
      await Promise.race([activation.catch(() => {}), delay(deadlineMs)]);
    }
    const orphan = this.orphan;
    if (orphan) {
      await Promise.race([orphan.catch(() => {}), delay(deadlineMs)]);
    }
    this.activation = undefined;

    const cleanup = this.cleanupTask ?? (this.module ? this.cleanup() : null);
    if (cleanup) {
      await Promise.race([cleanup.catch(() => {}), delay(deadlineMs)]);
    }
    if (!this.cleanupTask && !this.module) {
      this.phase = LifecyclePhase.Disabled;
      this.emit();
    }
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
      if (this.desired) {
        switch (this.phase) {
          case LifecyclePhase.Active:
          case LifecyclePhase.Enabling:
            return;
          case LifecyclePhase.Disabling:
            await this.cleanup();
            if (this.cleanupPending) return;
            continue;
          case LifecyclePhase.Failed:
            if (this.cleanupPending || !this.retryRequired) {
              await this.cleanup();
              if (this.cleanupPending) return;
              continue;
            }
            return;
          case LifecyclePhase.Disabled:
            if (this.orphan) return;
            this.startActivation();
            return;
        }
      } else {
        switch (this.phase) {
          case LifecyclePhase.Disabled:
            return;
          case LifecyclePhase.Enabling:
            return;
          case LifecyclePhase.Active:
          case LifecyclePhase.Failed:
          case LifecyclePhase.Disabling:
            await this.cleanup();
            if (this.cleanupPending) return;
            continue;
        }
      }
    }
  }

  private startActivation(): void {
    const generation = ++this.generation;
    this.phase = LifecyclePhase.Enabling;
    this.timedOut = false;
    this.retryRequired = false;
    this.cleanupPending = false;
    this.error = undefined;
    this.emit();

    const activation = (async () => {
      const module = await this.adapter.load();
      if (generation !== this.generation || this.disposed) {
        try {
          await this.adapter.deactivate(module);
        } catch {
          // A stale/disposed activation is best-effort cleanup only.
        }
        return;
      }
      this.module = module;
      await this.adapter.activate(module);
      if (generation !== this.generation || this.disposed) {
        try {
          await this.adapter.deactivate(module);
        } catch {
          // Clean up listeners registered by an activation that was abandoned.
        }
      }
    })();
    this.activation = activation;

    this.timeout = setTimeout(() => {
      if (generation !== this.generation || this.phase !== LifecyclePhase.Enabling) return;
      if (this.timedOut) return;

      this.timedOut = true;
      this.error = new LifecycleTimeoutError(
        `Plugin activation timed out after ${this.timeoutMs}ms`
      );
      this.retryRequired = this.desired;

      // Abandon the generation so the reconciler can clean up now. The
      // activation stays orphaned; when it eventually settles it deactivates
      // its module again, covering listeners registered after our cleanup.
      const orphan = this.activation;
      this.activation = undefined;
      this.generation += 1;
      if (orphan) {
        this.orphan = orphan;
        void orphan
          .finally(() => {
            if (this.orphan === orphan) {
              this.orphan = undefined;
              this.kick();
            }
          })
          .catch(() => {});
      }

      this.phase = this.module ? LifecyclePhase.Disabling : LifecyclePhase.Failed;
      this.emit();
      this.kick();
    }, this.timeoutMs);

    void activation.then(
      () => this.settleActivation(generation),
      (error: unknown) => this.settleActivation(generation, error)
    );
  }

  private settleActivation(generation: number, error?: unknown): void {
    if (generation !== this.generation) return;
    this.clearTimeout();
    this.activation = undefined;
    if (error !== undefined) this.error = error;

    if (this.disposed) {
      if (this.module) {
        void this.cleanup();
      } else {
        this.phase = LifecyclePhase.Disabled;
        this.emit();
      }
      return;
    }

    if (this.timedOut || !this.desired) {
      this.retryRequired = this.desired;
      this.phase = this.module
        ? LifecyclePhase.Disabling
        : this.desired
          ? LifecyclePhase.Failed
          : LifecyclePhase.Disabled;
      this.emit();
      this.kick();
      return;
    }

    if (error !== undefined) {
      this.retryRequired = this.desired;
      this.phase = this.module
        ? LifecyclePhase.Disabling
        : this.desired
          ? LifecyclePhase.Failed
          : LifecyclePhase.Disabled;
      this.emit();
      this.kick();
      return;
    }

    this.phase = LifecyclePhase.Active;
    this.timedOut = false;
    this.retryRequired = false;
    this.cleanupPending = false;
    this.error = undefined;
    this.emit();
    this.kick();
  }

  private cleanup(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    const task = this.runCleanup();
    this.cleanupTask = task;
    void task
      .finally(() => {
        if (this.cleanupTask === task) this.cleanupTask = null;
      })
      .catch(() => {});
    return task;
  }

  private async runCleanup(): Promise<void> {
    if (this.activation) return;
    if (!this.module) {
      this.cleanupPending = false;
      this.phase =
        this.desired && this.retryRequired ? LifecyclePhase.Failed : LifecyclePhase.Disabled;
      this.emit();
      return;
    }

    const module = this.module;
    this.phase = LifecyclePhase.Disabling;
    this.emit();
    try {
      await this.adapter.deactivate(module);
      this.module = undefined;
      this.cleanupPending = false;
    } catch (error) {
      this.error = error;
      this.cleanupPending = true;
      this.phase = LifecyclePhase.Failed;
      this.emit();
      return;
    }

    this.phase =
      this.desired && this.retryRequired ? LifecyclePhase.Failed : LifecyclePhase.Disabled;
    this.emit();
  }

  private clearTimeout(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
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
