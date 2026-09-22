import { describe, expect, it, vi } from "vitest";

import {
  combineDisposables,
  noopDisposable,
  toDisposable,
} from "@shared/disposable";

describe("toDisposable", () => {
  it("runs the teardown when disposed", () => {
    const teardown = vi.fn();

    toDisposable(teardown).dispose();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("runs the teardown at most once", () => {
    const teardown = vi.fn();
    const disposable = toDisposable(teardown);

    disposable.dispose();
    disposable.dispose();
    disposable.dispose();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does not run the teardown before it is disposed", () => {
    const teardown = vi.fn();

    toDisposable(teardown);

    expect(teardown).not.toHaveBeenCalled();
  });
});

describe("noopDisposable", () => {
  it("can be disposed repeatedly without doing anything", () => {
    const disposable = noopDisposable();

    expect(() => {
      disposable.dispose();
      disposable.dispose();
    }).not.toThrow();
  });
});

describe("combineDisposables", () => {
  it("disposes every member", () => {
    const first = vi.fn();
    const second = vi.fn();

    combineDisposables(toDisposable(first), toDisposable(second)).dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("disposes in reverse registration order", () => {
    const order: string[] = [];

    combineDisposables(
      toDisposable(() => order.push("first")),
      toDisposable(() => order.push("second")),
      toDisposable(() => order.push("third"))
    ).dispose();

    expect(order).toEqual(["third", "second", "first"]);
  });

  it("disposes the whole set at most once", () => {
    const first = vi.fn();
    const second = vi.fn();
    const combined = combineDisposables(
      toDisposable(first),
      toDisposable(second)
    );

    combined.dispose();
    combined.dispose();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("disposes the remaining members when one throws", () => {
    const after = vi.fn();
    const combined = combineDisposables(
      toDisposable(after),
      toDisposable(() => {
        throw new Error("teardown failed");
      })
    );

    // The throw is the combined handle's problem, not the caller's: a failing
    // teardown must not strand the registrations that have not run yet.
    expect(() => combined.dispose()).toThrow("teardown failed");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("is empty when given nothing", () => {
    expect(() => combineDisposables().dispose()).not.toThrow();
  });
});
