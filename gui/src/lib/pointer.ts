import type { Attachment } from "svelte/attachments";

const THRESHOLD = 2; // pixels
const THRESHOLD_SQ = THRESHOLD * THRESHOLD;
const CONTEXT_MENU_GUARD_MS = 3_000;

export function onpointerdrag(callback: (e: PointerEvent) => void): Attachment {
  return (el) => {
    if (!(el instanceof HTMLElement)) return;

    let pointerId: number | null = null;
    let sx = 0,
      sy = 0;
    let suppressContextMenu = false;
    let contextMenuTimer: ReturnType<typeof setTimeout> | null = null;

    const clearContextMenuSuppression = () => {
      suppressContextMenu = false;
      if (contextMenuTimer !== null) {
        clearTimeout(contextMenuTimer);
        contextMenuTimer = null;
      }
    };

    const onpointerdown = (e: PointerEvent) => {
      if (pointerId !== null) return;
      clearContextMenuSuppression();
      if (e.pointerType === "mouse" && e.button !== 0) return; // For mouse, only track left button

      e.preventDefault();

      pointerId = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;

      window.addEventListener("pointermove", onpointermove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("blur", stop);
    };

    const onpointermove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - sx,
        dy = e.clientY - sy;
      if (dx * dx + dy * dy >= THRESHOLD_SQ) {
        if (e.pointerType !== "mouse") {
          suppressContextMenu = true;
          contextMenuTimer = setTimeout(() => {
            suppressContextMenu = false;
            contextMenuTimer = null;
          }, CONTEXT_MENU_GUARD_MS);
        }
        stop();
        callback(e);
      }
    };

    const stop = (e?: PointerEvent | FocusEvent) => {
      if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
      pointerId = null;
      window.removeEventListener("pointermove", onpointermove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };

    const oncontextmenu = (e: MouseEvent) => {
      if (!suppressContextMenu) return;
      clearContextMenuSuppression();
      e.preventDefault();
      e.stopPropagation();
    };

    const onkeydown = (e: KeyboardEvent) => {
      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
        clearContextMenuSuppression();
      }
    };

    el.addEventListener("pointerdown", onpointerdown);
    window.addEventListener("keydown", onkeydown, true);
    el.addEventListener("contextmenu", oncontextmenu, true);

    return () => {
      el.removeEventListener("pointerdown", onpointerdown);
      el.removeEventListener("contextmenu", oncontextmenu, true);
      window.removeEventListener("keydown", onkeydown, true);
      stop();
      clearContextMenuSuppression();
    };
  };
}
