import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  capability: { supported: true } as { supported: boolean; reason?: string },
  policy: vi.fn(() => true),
}));

vi.mock("@open-orpheus/window", () => ({
  getPopupCapability: () => hoisted.capability,
  setWindowPopupPolicy: hoisted.policy,
}));

import { registerNativeWaylandPopup } from "../../src/main/menu/native-popup";

describe("native popup policy result", () => {
  beforeEach(() => {
    hoisted.capability = { supported: true };
    hoisted.policy.mockReset();
    hoisted.policy.mockReturnValue(true);
  });

  it("returns ok when the native policy is accepted", () => {
    expect(registerNativeWaylandPopup("target", "parent", 200, 100, { x: 4, y: 5 }, 8)).toEqual({
      ok: true,
    });
  });

  it("reports capability failures without calling native", () => {
    hoisted.capability = { supported: false, reason: "hooks-disabled" };
    expect(registerNativeWaylandPopup("target", "parent", 200, 100, undefined, 0)).toEqual({
      ok: false,
      reason: "no-hooks",
    });
    expect(hoisted.policy).not.toHaveBeenCalled();
  });

  it("rejects invalid geometry and inset", () => {
    expect(registerNativeWaylandPopup("target", "parent", 0, 100, undefined, 0)).toEqual({
      ok: false,
      reason: "invalid-size",
    });
    expect(registerNativeWaylandPopup("target", "parent", 200, 100, undefined, -1)).toEqual({
      ok: false,
      reason: "invalid-inset",
    });
  });

  it("reports a refused policy", () => {
    hoisted.policy.mockReturnValue(false);
    expect(registerNativeWaylandPopup("target", "parent", 200, 100, undefined, 0)).toEqual({
      ok: false,
      reason: "policy-refused",
    });
  });
});
