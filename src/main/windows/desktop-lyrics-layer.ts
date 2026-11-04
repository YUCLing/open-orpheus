/**
 * Whether the desktop lyrics take the compositor's layer shell.
 *
 * A layer surface is placed by margins, and a drag is the proxy replaying the
 * gesture against them. That is only smooth where the compositor puts the
 * surface where the new margins say on the commit that carries them. Nothing in
 * the protocol reports where a layer surface is or when it was arranged — which
 * is the very reason the proxy drives the gesture itself — so a compositor that
 * defers the arrange looks exactly like one that is lagging, and there is
 * nothing to ask at runtime: the compositor has to be known by name.
 *
 * The list is what the drag was measured to work on, not what it ought to work
 * on: every compositor here implements `zwlr_layer_shell_v1`, and the ones left
 * off are not missing it — Hyprland trails the pointer, labwc and Wayfire
 * jitter, and KWin does not move the surface on a margin change at all. The
 * wlroots family is exactly what a list reasoned about from the outside would
 * have included, and it splits down the middle.
 *
 * Everywhere off the list the lyrics stay an ordinary window — what they always
 * were, and what the window rules in `docs/WM_RULES.md` are for.
 */
const COMPOSITORS_THAT_FOLLOW_A_DRAG = ["niri", "sway", "river"];

/**
 * The variable that settles it either way: `1` for a layer surface, `0` for an
 * ordinary window. It answers for the compositors on the list as much as for the
 * others — the list is a default, not a fact about the compositor that only this
 * variable could override.
 *
 * Anything else (including nothing at all, and a value that is neither) leaves
 * the answer to the compositor.
 */
export const LAYER_SHELL_CHOICE = "LYRICS_LAYER_SHELL";

/**
 * Why the lyrics window is not to take a layer surface, or `null` when it is.
 *
 * `desktopName` is what the session calls its desktop, which is a
 * colon-separated list of names (`KDE:Plasma`) whenever more than one applies.
 */
export function whyNotALayerSurface(
  desktopName: string,
  choice: string | undefined
): string | null {
  if (choice === "1" || choice === "true") return null;
  if (choice === "0" || choice === "false") return "asked not to";
  const followed = desktopName
    .split(":")
    .some((name) => COMPOSITORS_THAT_FOLLOW_A_DRAG.includes(name.trim().toLowerCase()));
  if (followed) return null;
  return `${desktopName.trim() || "this desktop"} leaves a layer surface behind the pointer`;
}
