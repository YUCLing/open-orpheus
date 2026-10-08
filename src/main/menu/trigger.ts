import type { BrowserWindow } from "electron";

// The web app creates the menu asynchronously after handling a forwarded action.
// Never let a delayed or unrelated request consume an old window's click.
const FORWARDED_MENU_TRIGGER_TTL_MS = 1_000;
type MenuTrigger = { source: WeakRef<BrowserWindow>; expiresAt: number };
const forwardedMenuTriggers = new WeakMap<BrowserWindow, MenuTrigger>();

/** Preserve the window that clicked a menu action handled by another window. */
export function rememberMenuTrigger(requester: BrowserWindow, source: BrowserWindow) {
  if (requester.isDestroyed() || source.isDestroyed()) return;
  forwardedMenuTriggers.set(requester, {
    source: new WeakRef(source),
    expiresAt: Date.now() + FORWARDED_MENU_TRIGGER_TTL_MS,
  });
}

export function clearMenuTrigger(requester: BrowserWindow) {
  forwardedMenuTriggers.delete(requester);
}

/** Consume once, only while the source window still has focus. */
export function takeMenuTrigger(requester: BrowserWindow): BrowserWindow | null {
  const trigger = forwardedMenuTriggers.get(requester);
  forwardedMenuTriggers.delete(requester);
  if (!trigger || requester.isDestroyed() || Date.now() >= trigger.expiresAt) return null;
  const source = trigger.source.deref();
  return source && !source.isDestroyed() && source.isFocused() ? source : null;
}
