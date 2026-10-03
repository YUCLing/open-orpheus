/** Desktop-specific overlay timing, independent of native popup support. */
export function getOverlayPolicy(desktopName: string) {
  const desktops = desktopName.split(":").map((name) => name.trim().toLowerCase());
  // KDE may create its fullscreen surface before the renderer is mounted.
  if (desktops.includes("kde")) {
    return { platform: "kde", capturePhase: "before-create" } as const;
  }
  if (desktops.some((name) => name === "gnome" || name.startsWith("gnome-"))) {
    return { platform: "gnome", capturePhase: "before-show" } as const;
  }
  if (desktops.includes("niri")) {
    return { platform: "niri", capturePhase: "before-show" } as const;
  }
  // Keep the upstream capture-before-construction order for other desktops.
  return { platform: "other", capturePhase: "before-create" } as const;
}
