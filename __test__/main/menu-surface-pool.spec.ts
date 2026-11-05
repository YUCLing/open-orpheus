import { expect, it, vi } from "vitest";

import { SurfacePool } from "../../src/main/menu/surface/SurfacePool";
import type { MenuSurface } from "../../src/main/menu/surface/MenuSurface";

function surface(id: string) {
  return {
    id,
    prepare: vi.fn(),
    present: vi.fn(),
    show: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
  } as unknown as MenuSurface;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("refills one idle surface after acquisition", async () => {
  const created = [surface("a"), surface("b")];
  const factory = { create: vi.fn(async () => created.shift()!) };
  const pool = new SurfacePool(factory);

  const first = await pool.acquire();
  await Promise.resolve();
  await Promise.resolve();
  expect(first.id).toBe("a");
  expect(pool.idleCount).toBe(1);

  const second = await pool.acquire();
  expect(second.id).toBe("b");
  await pool.close();
});

it("shares one pending creation rather than starting a parallel one", async () => {
  const pending = deferred<MenuSurface>();
  const factory = { create: vi.fn(() => pending.promise) };
  const pool = new SurfacePool(factory);

  const first = pool.acquire();
  const second = pool.acquire();
  await Promise.resolve();
  expect(factory.create).toHaveBeenCalledOnce();

  pending.resolve(surface("a"));
  await expect(first).resolves.toMatchObject({ id: "a" });
  await expect(second).resolves.toMatchObject({ id: "a" });
  await pool.close();
});

it("rejects when a cold creation fails", async () => {
  const pool = new SurfacePool({ create: vi.fn(async () => Promise.reject(new Error("boom"))) });
  await expect(pool.acquire()).rejects.toThrow("boom");
});

it("reports refill failure without poisoning the pool", async () => {
  const created = [surface("a")];
  const onError = vi.fn();
  const factory = {
    create: vi
      .fn()
      .mockImplementationOnce(async () => created.shift()!)
      .mockImplementationOnce(async () => Promise.reject(new Error("refill"))),
  };
  const pool = new SurfacePool(factory, onError);

  await pool.acquire();
  await Promise.resolve();
  await Promise.resolve();
  expect(onError).toHaveBeenCalledOnce();
  expect(pool.idleCount).toBe(0);
});

it("gives a claimed pending refill to exactly one waiter", async () => {
  const refill = deferred<MenuSurface>();
  const factory = {
    create: vi
      .fn()
      .mockResolvedValueOnce(surface("a"))
      .mockReturnValueOnce(refill.promise)
      .mockResolvedValueOnce(surface("c"))
      .mockResolvedValue(surface("d")),
  };
  const pool = new SurfacePool(factory);

  const first = await pool.acquire();
  expect(first.id).toBe("a");

  const second = pool.acquire();
  refill.resolve(surface("b"));
  await expect(second).resolves.toMatchObject({ id: "b" });
  await expect(pool.acquire()).resolves.toMatchObject({ id: "c" });
  await pool.close();
});
