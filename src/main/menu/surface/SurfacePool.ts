import type { MenuSurface, SurfaceFactory } from "./MenuSurface";

/** One idle surface, one creation in flight; active surfaces belong to callers. */
interface PendingSurface {
  promise: Promise<MenuSurface>;
  claimed: boolean;
}

export class SurfacePool {
  private idle: MenuSurface | null = null;
  private pending: PendingSurface | null = null;
  private lock: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly factory: SurfaceFactory,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  async acquire(): Promise<MenuSurface> {
    return this.withLock(async () => {
      if (this.closed) throw new Error("surface pool is closed");

      if (this.idle) {
        const surface = this.idle;
        this.idle = null;
        this.refill();
        return surface;
      }

      if (this.pending) {
        const pending = this.pending;
        pending.claimed = true;
        const surface = await pending.promise;
        if (this.pending === pending) this.pending = null;
        if (this.closed) {
          surface.close();
          throw new Error("surface pool is closed");
        }
        this.refill();
        return surface;
      }

      const surface = await this.factory.create();
      this.refill();
      return surface;
    });
  }

  get idleCount(): number {
    return this.idle ? 1 : 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.idle?.close();
    this.idle = null;

    const pending = this.pending;
    this.pending = null;
    if (pending) {
      try {
        (await pending.promise).close();
      } catch {
        // Creation failure during shutdown has no useful recovery.
      }
    }
  }

  private refill(): void {
    if (this.closed || this.idle || this.pending) return;
    const pending: PendingSurface = {
      promise: this.factory.create(),
      claimed: false,
    };
    this.pending = pending;
    void pending.promise.then(
      (surface) => {
        if (this.pending !== pending) {
          surface.close();
          return;
        }
        this.pending = null;
        if (this.closed || pending.claimed) {
          if (!pending.claimed) surface.close();
          return;
        }
        this.idle = surface;
      },
      (error) => {
        if (this.pending === pending) this.pending = null;
        this.onError(error);
      }
    );
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
