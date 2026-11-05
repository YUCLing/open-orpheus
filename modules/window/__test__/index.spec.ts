import test from "ava";

test("module can load", async (t) => {
  await t.notThrowsAsync(async () => {
    const window = await import("../index");
    t.is(typeof window.clearWindowPopupPolicy, "function");
    t.is(typeof window.cancelWindowPointerAxisCapture, "function");
    t.is(typeof window.captureCursorEnter, "function");
    t.is(typeof window.getPopupCapability, "function");
    t.is(typeof window.isWindowActivated, "function");
    t.is(typeof window.latestWindowPress, "function");
    t.is(typeof window.captureWindowNextPointerAxis, "function");
    t.is(typeof window.drainWindowCallbacks, "function");
    t.is(typeof window.getUniqueDisplayId, "function");
    t.is(typeof window.setWindowLayerShell, "function");
    t.is(typeof window.setWindowPopupPolicy, "function");
    t.is(typeof window.supportsNativeWaylandPopup, "function");
  });
});
