import type { Attachment } from "svelte/attachments";

/**
 * How long the window keeps drawing after the last pointer event on it.
 *
 * A drag or a resize is one unbroken pointer interaction, so the pulse outlives
 * any of them; the tail only has to span the gap between two of them.
 */
const IDLE_MS = 3000;

/** The painted mark, in CSS pixels. */
const MARK = 8;

/** Two values a rasterizer cannot round together, and the eye cannot see. */
const FAINT = "rgba(0, 0, 0, 0.004)";
const FAINTER = "rgba(0, 0, 0, 0.008)";

/**
 * Keep the window drawing while the pointer is working in it.
 *
 * On Wayland a layer surface's geometry — a move, a resize — is double-buffered:
 * the compositor adopts it when the surface is committed, and a client commits
 * only when it has something to draw. An idle window therefore never picks the
 * new geometry up, and only moves once some unrelated event makes it draw.
 * Repainting an imperceptible mark keeps frames coming for as long as the
 * pointer is on the window, which is exactly as long as a drag or a resize can
 * last — and it is what the window would be doing on its own if it had anything
 * moving on it.
 */
export const paintPulseAttachment: Attachment = (element) => {
  // The mark below is drawn in CSS pixels, which only an element can be given.
  if (!(element instanceof HTMLElement)) return;

  const mark = document.createElement("div");
  mark.style.cssText = [
    "position: fixed",
    "left: 0",
    "top: 0",
    `width: ${MARK}px`,
    `height: ${MARK}px`,
    "pointer-events: none",
    "z-index: 2147483647",
    `background: ${FAINT}`,
  ].join(";");
  element.appendChild(mark);

  let frame: number | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let faint = false;

  const draw = () => {
    faint = !faint;
    mark.style.background = faint ? FAINT : FAINTER;
    frame = requestAnimationFrame(draw);
  };

  const wake = () => {
    if (frame === null) frame = requestAnimationFrame(draw);
    clearTimeout(idle);
    idle = setTimeout(sleep, IDLE_MS);
  };

  const sleep = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    mark.style.background = FAINT;
  };

  const events = ["pointerenter", "pointermove", "pointerdown"];
  for (const event of events) element.addEventListener(event, wake);

  return () => {
    for (const event of events) element.removeEventListener(event, wake);
    clearTimeout(idle);
    if (frame !== null) cancelAnimationFrame(frame);
    mark.remove();
  };
};
