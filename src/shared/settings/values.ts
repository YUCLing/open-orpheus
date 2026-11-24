/**
 * Value types for settings whose values the app enumerates.
 *
 * These describe what this build writes. Reads are not validated, so a store
 * written by an older build can still yield a value outside the union; callers
 * that branch on a value must keep handling the unexpected case.
 */

/** Values written by the tray click behavior setting. */
export type TrayClickBehavior =
  | "depends-on-main-window"
  | "always-show-menu"
  | "always-show-main-window";

/** Values written by the window lifecycle setting. */
export type WindowLifecycle = "on-demand" | "hide-only";

/** Values written by the main window size limit override (a stringified boolean). */
export type WindowSizeLimitOverride = "true" | "false";
