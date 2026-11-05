import { getPopupCapability, setWindowPopupPolicy } from "@open-orpheus/window";

export type PopupPolicyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no-hooks"
        | "not-wayland"
        | "invalid-size"
        | "invalid-inset"
        | "invalid-anchor"
        | "policy-refused";
    };

/**
 * Register a popup policy for a menu surface.
 *
 * The target window is named by its decorated title. Failures are typed so the
 * caller can use the overlay.
 */
export function registerNativeWaylandPopup(
  parentWindowId: string,
  targetWindowId: string,
  width: number,
  height: number,
  anchor: { x: number; y: number } | undefined,
  shadowInset: number,
  anchorRectWidth?: number
): PopupPolicyResult {
  const capability = getPopupCapability();
  if (!capability.supported) {
    return {
      ok: false,
      reason: capability.reason === "hooks-disabled" ? "no-hooks" : "not-wayland",
    };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, reason: "invalid-size" };
  }
  if (!Number.isInteger(shadowInset) || shadowInset < 0) {
    return { ok: false, reason: "invalid-inset" };
  }
  if (
    anchorRectWidth !== undefined &&
    (!Number.isInteger(anchorRectWidth) || anchorRectWidth <= 0)
  ) {
    return { ok: false, reason: "invalid-anchor" };
  }

  try {
    return setWindowPopupPolicy(
      targetWindowId,
      parentWindowId,
      width,
      height,
      anchor?.x,
      anchor?.y,
      shadowInset,
      anchorRectWidth
    )
      ? { ok: true }
      : { ok: false, reason: "policy-refused" };
  } catch {
    return { ok: false, reason: "policy-refused" };
  }
}
