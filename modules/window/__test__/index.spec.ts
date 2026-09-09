import test from "ava";

test("module can load", async (t) => {
  await t.notThrowsAsync(async () => {
    const window = await import("../index");
    t.is(typeof window.armNextWindowAsPopup, "function");
    t.is(typeof window.cancelNextWindowFirstCursorEnter, "function");
    t.is(typeof window.cancelPendingPopup, "function");
    t.is(typeof window.cancelWindowPointerAxisCapture, "function");
    t.is(typeof window.captureNextWindowFirstCursorEnter, "function");
    t.is(typeof window.captureWindowNextPointerAxis, "function");
    t.is(typeof window.isWindowWaylandPopup, "function");
    t.is(typeof window.supportsGnomeWaylandPopup, "function");
  });
});
