import { join } from "node:path";

import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import photon from "@silvia-odwyer/photon-node";
import {
  DesktopEnvironment,
  LayerShellLayer,
  dragWindow,
  getDesktopEnvironment,
} from "@open-orpheus/window";

import {
  DesktopLyricsPlayInfo,
  LineMode,
  LyricsStyle,
  ShowTranslate,
  TextAlignType,
} from "$sharedTypes/desktop-lyrics";

import {
  guiUrl,
  isLayerShellNativeComplete,
  mainWindow,
  ManagedWindow,
  OnDemandWindow,
  switchWindowPolicy,
} from "../window";
import type { LayerShellOptions } from "../window";
import { LAYER_SHELL_CHOICE, whyNotALayerSurface } from "./desktop-lyrics-layer";
import { registerIpcHandlers } from "../../bridge/register";
import type {
  DesktopLyricsContract,
  DesktopLyricsPreviewContract,
} from "../../bridge/contracts/desktop-lyrics-api";
import { registerInputRegionHandlers } from "../../bridge/common/inputRegion";
import { registerLyricsHandlers } from "../../bridge/common/lyrics";
import { registerSettingsHandlers } from "../../bridge/common/settings";
import { events as settingsEvents, kv as settings } from "../settings";

export const lyricsStyle: LyricsStyle = {
  font: {
    family: "sans-serif",
    size: 36,
    weight: "normal",
  },
  textAlign: [TextAlignType.Center, TextAlignType.Center],
  lineMode: LineMode.Single,
  vertical: false,
  color: {
    notPlayed: {
      top: "#ffffff",
      bottom: "#cccccc",
    },
    played: {
      top: "#00ff88",
      bottom: "#00cc66",
    },
  },
  outline: {
    notPlayed: "transparent",
    played: "transparent",
  },
  dropShadow: false,
  showTranslate: ShowTranslate.Translate,
};
export function refreshLyricsStyle() {
  return window.send("desktopLyrics.styleUpdate", lyricsStyle);
}

export let lyricsOffset = 0;
export function setLyricsOffset(offset: number) {
  lyricsOffset = offset;
  return window.send("desktopLyrics.offsetUpdate", offset);
}

export let lyricsLocked = false;
export function setLyricsLocked(locked: boolean) {
  lyricsLocked = locked;
  return window.send("desktopLyrics.lockUpdate", locked);
}

let lyricsPlayInfo: DesktopLyricsPlayInfo | null = null;
export function updateLyricsPlayInfo(info: DesktopLyricsPlayInfo | null) {
  lyricsPlayInfo = info;
  return window.send("desktopLyrics.playInfoUpdate", info);
}

function performAction(action: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("channel.call", "player.ondesktoplyricaction", action);
  }
}

/** Distance the default placement keeps from the bottom of the work area. */
const LYRICS_BOTTOM_MARGIN = 96;

/** The size a lyrics window starts at, before the user changes it. */
const LYRICS_DEFAULT_SIZE = { width: 800, height: 225 };

/** How long a toplevel has to hold still before its placement is written. */
const LYRICS_GEOMETRY_SETTLE_MS = 400;

/** Where the lyrics are, in the logical coordinates Electron reports. */
type LyricsGeometry = { x: number; y: number; width: number; height: number };

/** The xdg-toplevel resize edge flags, which is how a push is reported. */
const EDGE_TOP = 1;
const EDGE_BOTTOM = 2;
const EDGE_LEFT = 4;
const EDGE_RIGHT = 8;

/** The settings key the last placement is kept under. */
const LYRICS_GEOMETRY_KEY = "desktopLyrics.geometry";

/**
 * How long a window built again has to come up before the move is given up on.
 *
 * It is a page load, not a window creation: the deadline has to cover the
 * renderer fetching and mounting, which in a development build can be seconds
 * on a cold cache. Giving up costs nothing visible — the window the user was
 * dragging is still on screen and still theirs.
 */
const LYRICS_HOP_TIMEOUT_MS = 5000;

/** The settings key the screen the lyrics were left on is kept under. */
const LYRICS_OUTPUT_KEY = "desktopLyrics.output";

/** The placement a first run starts from: bottom centre of the primary display. */
function defaultLyricsGeometry(): LyricsGeometry {
  const { width, height } = LYRICS_DEFAULT_SIZE;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: Math.max(0, Math.round((workArea.width - width) / 2)),
    y: Math.max(0, Math.round(workArea.height - height - LYRICS_BOTTOM_MARGIN)),
    width,
    height,
  };
}

let lyricsGeometry = defaultLyricsGeometry();

/**
 * How large the screen the lyrics are on is, as the renderer last reported it.
 *
 * A layer surface cannot be asked where it is, so this is what the application
 * has to identify its screen by — a display of the same size is the one it is
 * on.
 */
let lyricsScreen: { width: number; height: number } | null = null;

/**
 * The output the lyrics are on, by the name the native layer reports.
 *
 * A layer surface keeps the output the compositor created it on, and the
 * compositor never says which that was: the native layer watches the surface
 * enter it and names it. That name identifies the screen here, and it is what a
 * window created again on it is asked for by — the same name the native layer
 * resolves, with nothing in between to match up.
 */
let lyricsOutput: string | null = null;

/**
 * Where a placement's coordinates are measured from.
 *
 * A layer surface is asked for at margins against the one screen it lives on,
 * and a window the window manager places is placed at a position on the desk.
 * The two are different spaces, and only one of them is in use at a time.
 */
type PlacementSpace = "screen" | "desk";

/** Whether a rectangle wholly contains `geometry`. */
function insideWhole(geometry: LyricsGeometry, rect: Electron.Rectangle): boolean {
  return (
    geometry.x >= rect.x &&
    geometry.y >= rect.y &&
    geometry.x + geometry.width <= rect.x + rect.width &&
    geometry.y + geometry.height <= rect.y + rect.height
  );
}

/**
 * Whether a layer surface can be given `geometry` as margins.
 *
 * The screen is the one the lyrics were left on, and failing that the smallest
 * one there is — every other screen is at least as large, so a placement that
 * fits it is one the window can be reached at wherever it ends up. With no
 * screen to measure against at all the placement is kept as it is: better where
 * the user left it than at the default position of a screen it may not be on.
 */
function fitsOnItsScreen(geometry: LyricsGeometry): boolean {
  const display = identifiedDisplay() ?? smallestDisplay();
  if (!display) return true;
  return insideWhole(geometry, {
    x: 0,
    y: 0,
    width: Math.round(display.size.width),
    height: Math.round(display.size.height),
  });
}

/** Whether a window the window manager places can be reached at `geometry`. */
function fitsOnTheDesk(geometry: LyricsGeometry): boolean {
  return screen.getAllDisplays().some((display) => insideWhole(geometry, display.bounds));
}

/**
 * Keep a placement that can be shown, or put the lyrics back where they start.
 *
 * A placement only means anything in its own space, so it is only meaningful
 * against the screens of that space — the layout of the others is not part of
 * it, and a position can be well inside the layout while being nowhere near the
 * screen the window is created on. That is what a remembered placement has to
 * survive: screens unplugged, rearranged or turned off since.
 *
 * A placement is also not equally useful at any point on a screen: the part of
 * the window that accepts the pointer is the part of it that has something to
 * show, so a strip hanging over the edge is a strip the user cannot take hold
 * of to drag it back. The native layer holds a drag to the same rule — whole on
 * the screen — and a placement that cannot be shown whole is not kept at all:
 * the lyrics return to where a first run puts them.
 *
 * The size is left alone: a window larger than its screen is one the native
 * layer shrinks to fit, and it reports that back to be kept like any other
 * placement.
 */
function usablePlacement(geometry: LyricsGeometry, space: PlacementSpace): LyricsGeometry {
  if (space === "desk" ? fitsOnTheDesk(geometry) : fitsOnItsScreen(geometry)) return geometry;
  const { x, y } = defaultLyricsGeometry();
  return { ...geometry, x, y };
}

/** Remember a placement, now and for the next run. */
function saveLyricsGeometry(geometry: LyricsGeometry, space: PlacementSpace = placementSpace()) {
  lyricsGeometry = usablePlacement(geometry, space);
  void settings.set(LYRICS_GEOMETRY_KEY, lyricsGeometry);
}

/**
 * Remember which screen the lyrics are on.
 *
 * A layer surface keeps the output it was created on, and the compositor picks
 * one when the application does not say: without this, a restart would put the
 * window back on whichever screen happens to be active, at margins measured
 * from a corner it is no longer near.
 */
function saveLyricsOutput(output: string | null) {
  lyricsOutput = output;
  void settings.set(LYRICS_OUTPUT_KEY, output);
}

/** Read back the placement the user left the lyrics at, and the screen. */
async function loadLyricsGeometry() {
  // The screen first: it is what says how large the corner the placement is
  // measured from is.
  const output = await settings.get(LYRICS_OUTPUT_KEY);
  if (typeof output === "string") lyricsOutput = output;

  const saved = (await settings.get(LYRICS_GEOMETRY_KEY)) as Partial<LyricsGeometry> | undefined;
  if (!saved) return;
  const merged = { ...lyricsGeometry, ...saved };
  if (!Object.values(merged).every((value) => Number.isFinite(value))) return;
  lyricsGeometry = usablePlacement(merged as LyricsGeometry, placementSpace());
}

/**
 * The window options for the lyrics, at the placement they are remembered at.
 *
 * A layer surface is placed by its margins, so the coordinates are left to the
 * native layer there. Anywhere but Wayland the window manager tells the client
 * where the window is, which is what the remembered placement is written from
 * and what asking for one means; on Wayland a client is never told, so an
 * ordinary window there is left where the compositor puts it — the same thing
 * it had before any of this existed.
 */
function desktopLyricsWindowOptions(layerShell: boolean): BrowserWindowConstructorOptions {
  const { x, y, width, height } = lyricsGeometry;
  const positioned = !layerShell && getDesktopEnvironment() !== DesktopEnvironment.Wayland;
  return {
    ...(positioned ? { x, y } : {}),
    width,
    height,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: true,
    show: false,
    title: "Open Orpheus Lyrics",
    webPreferences: {
      partition: "open-orpheus",
      preload: join(import.meta.dirname, "desktop-lyrics.cjs"),
    },
  } satisfies BrowserWindowConstructorOptions;
}

/**
 * The layer-shell policy the lyrics window takes where the compositor can give
 * it one.
 *
 * On the overlay layer the lyrics are above everything the compositor draws —
 * including a window that is fullscreen, which is what a floating toplevel is
 * not — and the window stops being a window at all: nothing tiles it, and no
 * window rule is needed to keep it there. The surface is anchored to the top
 * left with the margins carrying its position, which is the one shape the
 * native layer can move by hand; a drag and an interactive resize are replayed
 * against those margins, since the protocol gives a layer surface neither.
 *
 * Sizes and positions are in the same logical coordinates Electron reports,
 * which is also what the remembered placement is kept in.
 */
function lyricsLayerShellOptions(): LayerShellOptions {
  const { x, y, width, height } = lyricsGeometry;
  return {
    namespace: "open-orpheus-lyrics",
    ...(lyricsOutput === null ? {} : { output: lyricsOutput }),
    layer: LayerShellLayer.Overlay,
    anchorLeft: true,
    anchorTop: true,
    width,
    height,
    marginLeft: x,
    marginTop: y,
    // Do not make room for anything, and let nothing move us: the user places
    // the lyrics, not the compositor's bars.
    exclusiveZone: -1,
    // On demand: a click gives the window keyboard focus, the way it had it as
    // a toplevel, without taking the keyboard away from the rest of the session.
    keyboardInteractivity: 2,
  };
}

/**
 * Ask the window's renderer for the size of the screen it is on.
 *
 * Only the renderer can read it, and the window it reads it from is the one the
 * native layer has to hold inside that screen; the report at mount can arrive
 * before the surface the native layer records it against exists, so it is asked
 * for again once the surface is known to be up.
 */
/** Windows whose renderer has already been asked for the size of its screen. */
const askedForScreenSize = new WeakSet<ManagedWindow>();

/** Windows whose layer events have already been subscribed to. */
const subscribedToLayerEvents = new WeakSet<ManagedWindow>();

function requestScreenSize(managed: ManagedWindow) {
  // Once per window. The report at mount can be too early to be recorded, and
  // the answer does not change afterwards — a window that ends up on another
  // screen is a window built again, with an identity of its own.
  if (askedForScreenSize.has(managed)) return;
  askedForScreenSize.add(managed);
  managed.send("desktopLyrics.requestScreenSize");
}

/**
 * The screen the lyrics are on, as far as the application can tell.
 *
 * The native layer names it, which is the only account of a layer surface's
 * output there is; failing that, the size the renderer reported is enough to
 * tell screens of different sizes apart.
 */
function identifiedDisplay(): Electron.Display | null {
  const displays = screen.getAllDisplays();
  if (lyricsOutput !== null) {
    const named = displays.find((display) => display.label === lyricsOutput);
    if (named) return named;
  }
  if (lyricsScreen !== null) {
    const { width, height } = lyricsScreen;
    const sized = displays.find(
      (display) =>
        Math.round(display.size.width) === width && Math.round(display.size.height) === height
    );
    if (sized) return sized;
  }
  return null;
}

/** The screen the lyrics are on, or the primary one when that cannot be told. */
function currentDisplay(): Electron.Display | null {
  return identifiedDisplay() ?? screen.getPrimaryDisplay() ?? null;
}

/** The smallest screen there is, which every other one is at least as large as. */
function smallestDisplay(): Electron.Display | null {
  const area = (display: Electron.Display) => display.size.width * display.size.height;
  return [...screen.getAllDisplays()].sort((a, b) => area(a) - area(b))[0] ?? null;
}

/** The screen that starts where `from` ends, in the direction the user pushed. */
function displayBeyond(from: Electron.Display, edges: number): Electron.Display | null {
  const origin = from.bounds;
  const horizontal = (edges & (EDGE_LEFT | EDGE_RIGHT)) !== 0;
  const startsAt = (display: Electron.Display): number | null => {
    const bounds = display.bounds;
    if (edges & EDGE_RIGHT) return bounds.x - (origin.x + origin.width);
    if (edges & EDGE_LEFT) return origin.x - (bounds.x + bounds.width);
    if (edges & EDGE_BOTTOM) return bounds.y - (origin.y + origin.height);
    if (edges & EDGE_TOP) return origin.y - (bounds.y + bounds.height);
    return null;
  };
  // How much of the edge the user pushed through a screen covers. A screen
  // further along that direction is only next to this one if it covers any of
  // it at all: one that merely starts past the corner, diagonally away, can be
  // nearer and still not be the screen the drag was heading for.
  const overlap = (display: Electron.Display): number => {
    const bounds = display.bounds;
    return horizontal
      ? Math.min(bounds.y + bounds.height, origin.y + origin.height) - Math.max(bounds.y, origin.y)
      : Math.min(bounds.x + bounds.width, origin.x + origin.width) - Math.max(bounds.x, origin.x);
  };
  // Screens are laid out in the same logical space the lyrics are placed in, so
  // this is a comparison of rectangles — and the nearest one in that direction
  // is the next one over, however the layout is arranged. Two of them at the
  // same distance are told apart by how much of that edge they share, since one
  // of those can be a screen that only touches the corner.
  const candidates = screen
    .getAllDisplays()
    .filter((display) => display.id !== from.id)
    .map((display) => ({ display, distance: startsAt(display) }))
    .filter(({ distance }) => distance !== null && distance >= 0);
  const beside = candidates.filter(({ display }) => overlap(display) > 0);
  return (
    (beside.length > 0 ? beside : candidates).sort(
      (a, b) => (a.distance ?? 0) - (b.distance ?? 0) || overlap(b.display) - overlap(a.display)
    )[0]?.display ?? null
  );
}

/** Where the lyrics land on a screen they have just been pushed onto. */
function placementOn(display: Electron.Display, edges: number): LyricsGeometry {
  const { width, height } = lyricsGeometry;
  const area = display.workAreaSize;
  const within = (value: number, most: number) => Math.min(Math.max(value, 0), Math.max(most, 0));
  let { x, y } = lyricsGeometry;
  if (edges & EDGE_RIGHT) x = 0;
  else if (edges & EDGE_LEFT) x = Math.max(area.width - width, 0);
  if (edges & EDGE_BOTTOM) y = 0;
  else if (edges & EDGE_TOP) y = Math.max(area.height - height, 0);
  return { width, height, x: within(x, area.width - width), y: within(y, area.height - height) };
}

/** Whether a move to another screen is already under way. */
let movingToAnotherScreen = false;

/**
 * The move to another screen that is under way, and how to give up on it.
 *
 * Never more than one at a time. It is held here rather than inside the move
 * because giving up has to be possible from outside it, and synchronously: a
 * caller that is about to change something the move would otherwise undo cannot
 * wait for the page load the move is blocked on.
 */
let abandonPendingMove: (() => void) | null = null;

/** Windows whose page has reported itself up. */
const pagesUp = new WeakSet<ManagedWindow>();

/** Windows waiting for that report. */
const waitingForPage = new WeakMap<ManagedWindow, () => void>();

/** Record that `managed`'s page has mounted and asked for its first update. */
function reportPageIsUp(managed: ManagedWindow) {
  pagesUp.add(managed);
  waitingForPage.get(managed)?.();
  waitingForPage.delete(managed);
}

/**
 * Resolve once `managed` has something to show, or reject if it never does.
 *
 * The renderer asks for a full update as soon as it has mounted, and that is the
 * one report of a window being up: `ready-to-show` is not emitted for a
 * transparent window, and a window whose page never loads would otherwise look
 * exactly like one that did.
 */
function whenPageIsUp(managed: ManagedWindow): Promise<void> {
  if (pagesUp.has(managed)) return Promise.resolve();
  const wnd = managed.window;
  if (!wnd || wnd.isDestroyed()) {
    return Promise.reject(new Error("the window built again is already gone"));
  }
  return new Promise((resolve, reject) => {
    const closed = () => {
      waitingForPage.delete(managed);
      reject(new Error("the window built again was closed before its page was up"));
    };
    wnd.once("closed", closed);
    waitingForPage.set(managed, () => {
      wnd.off("closed", closed);
      resolve();
    });
  });
}

/** Ask a window to show, and resolve once it has a page to show. */
async function showAndWaitForPage(managed: ManagedWindow) {
  // A window that is already built loads its page while it is still hidden, so
  // there the page is waited for first and the window is shown only once it has
  // one — a page that never loads then never takes the place of the window the
  // user was dragging, not even for the length of the wait. The on-demand
  // lifecycle has no window at all until it is shown, so the order there is the
  // other way round.
  if (managed.window) {
    await whenPageIsUp(managed);
    await managed.show();
    return;
  }
  await managed.show();
  await whenPageIsUp(managed);
}

/**
 * Move the lyrics to the screen the user dragged them onto.
 *
 * This is what a drag that ran out of screen asks for, and it is a window
 * creation rather than a move: a layer surface keeps the output it was created
 * on for its whole life, and the protocol has no request that changes it. The
 * window the user was dragging is therefore replaced by one created on the
 * screen the pointer was left on, placed against the edge they pushed towards —
 * so the lyrics end up where the drag was going, however far it went.
 *
 * A drag only ends up somewhere else by having pushed the window against the
 * edge of its screen and then out from under the pointer, which the native
 * layer reports; a window merely parked at the edge keeps the pointer on it,
 * and nothing happens.
 */
async function hopToNextScreen(edges: number) {
  // One at a time. A drag across an edge can report the push more than once —
  // the window it was reported for is replaced under the pointer that is still
  // holding it, and the replacement is dragged into the same edge — and two of
  // these at once build two windows for one drag: the name is handed to one of
  // them, and the other stays on screen with nothing left that can close it.
  if (movingToAnotherScreen) return;
  movingToAnotherScreen = true;
  try {
    await moveToTheScreenPushedTowards(edges);
  } finally {
    movingToAnotherScreen = false;
  }
}

async function moveToTheScreenPushedTowards(edges: number) {
  const from = currentDisplay();
  // The screen the pointer was left on is where the user dragged the lyrics to.
  // It is only readable while the pointer is over one of this application's
  // windows, though, so the last position it knows can be no further than the
  // edge the drag was pushed through — and the screen that starts there is what
  // that edge means.
  const under = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const target = under && under.id !== from?.id ? under : from ? displayBeyond(from, edges) : null;
  if (!target) {
    LOGGER.info(
      { edges, screen: under?.label ?? under?.id },
      "no screen to move the desktop lyrics to in that direction"
    );
    return;
  }
  LOGGER.info(
    { edges, from: lyricsOutput ?? from?.id, to: target.label ?? target.id },
    "moving the desktop lyrics to the screen the pointer was left on"
  );

  // Where the lyrics are now, to put back if the window built again never comes
  // up: the one on screen is still there, and still on that screen. It has to
  // be set before the window is created, because that is what the window is
  // created at.
  const before = { geometry: lyricsGeometry, output: lyricsOutput, screen: lyricsScreen };
  lyricsGeometry = placementOn(target, edges);
  saveLyricsOutput(target.label ?? null);
  lyricsScreen = target.size;
  // The placement the window is created at is also the one the next launch has
  // to come back to, and nothing else writes it: a window that is already
  // inside its screen is never corrected, so no report of its own would. The
  // failure below puts the old one back.
  void settings.set(LYRICS_GEOMETRY_KEY, lyricsGeometry);

  // The window the user was dragging is only let go of once its replacement has
  // something to show: a lyrics window that cannot be built again is one the
  // user has no way of getting back, and the placement just remembered is the
  // only thing that would have put it back.
  const previous = window;
  // Whether the lyrics were on screen when the move started. What the answer
  // means is only ever a comparison with this: a window that reports itself
  // hidden for a reason of its own is not the user having hidden the lyrics.
  const wasOnScreen = previous?.wantsToBeVisible() ?? false;
  let next: ManagedWindow | undefined;
  // Giving up puts the window, the placement and the screen back where they
  // were and throws the replacement away. Idempotent, because it can be reached
  // both from here and from whoever stopped the move.
  let abandoned = false;
  const giveUp = () => {
    if (abandoned) return;
    abandoned = true;
    // A lyrics window is born answering to the name the window on screen does,
    // and a name is looked up by whichever wrapper comes first: this one left
    // behind would be the window a later hide or show reached — one whose own
    // window is gone, which the on-demand lifecycle would then build again
    // alongside the lyrics that are already there.
    next?.setData("name", "");
    next?.destroy();
    // Unless something else has taken over in the meantime: a lifecycle switch
    // builds a window of its own, and that one is the application's now.
    if (window === next) window = previous;
    lyricsGeometry = before.geometry;
    lyricsScreen = before.screen;
    saveLyricsOutput(before.output);
    // Exactly what was there before: a geometry report from the window being
    // thrown away may already have written the other screen's placement.
    void settings.set(LYRICS_GEOMETRY_KEY, before.geometry);
  };
  try {
    next = createWindowForLifecycle(await settings.get("window.lifecycle"));
    window = next;
    abandonPendingMove = giveUp;
    // A replacement that never gets there would leave the move half-done: the
    // window the user was dragging is still on screen, and the one that took
    // its name has nothing to show — so every later show or close goes to the
    // wrong one. The wait is therefore bounded, and giving up puts everything
    // back.
    await Promise.race([
      showAndWaitForPage(next),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("the window built again never came up")),
          LYRICS_HOP_TIMEOUT_MS
        );
      }),
    ]);
    // The lyrics can have been hidden while the page was loading: a hide goes
    // to the window that is on screen, which is the one this one is here to
    // replace, and it is still that window the user is looking at. Hidden, they
    // are to stay hidden — the replacement is not what they hid.
    if (abandoned || (wasOnScreen && !previous?.wantsToBeVisible())) return giveUp();
    // Once it is up: the name is how everything else reaches this window, and
    // the wrapper it is being taken from has to stop answering to it — the
    // lookup takes whichever comes first, and the window behind that one is on
    // its way out.
    previous?.moveNameTo(next);
    LOGGER.info(
      { from: previous?.id, to: next.id, name: next.getData("name") },
      "the desktop lyrics were built again"
    );
  } catch (err) {
    // A move that was stopped is not a move that went wrong.
    if (!abandoned) {
      LOGGER.error(
        { err, edges, to: target.label ?? target.id },
        "the desktop lyrics could not be moved to another screen"
      );
    }
    return giveUp();
  } finally {
    abandonPendingMove = null;
  }
  previous?.destroy();
}

/** What the session calls its desktop, which is a colon-separated list. */
const desktopName =
  process.env.XDG_CURRENT_DESKTOP ||
  process.env.XDG_SESSION_DESKTOP ||
  process.env.DESKTOP_SESSION ||
  "";

/**
 * Why the lyrics cannot take a layer surface here, or `null` when they can.
 *
 * One answer for two callers: the window that has to decide whether to ask for
 * the layer role, and the placement that has to know which space it is measured
 * in — the two follow from each other, and a placement read in the wrong one is
 * a window somewhere the user never put it.
 */
function whyLayerShellIsUnavailable(): string | null {
  // The compositor first: whether a layer surface can be dragged on it at all
  // decides the shape of the window, and `desktop-lyrics-layer.ts` is where
  // that is argued.
  const byCompositor = whyNotALayerSurface(desktopName, process.env[LAYER_SHELL_CHOICE]);
  if (byCompositor !== null) return byCompositor;
  if (!ManagedWindow.isLayerShellAvailable()) return "the compositor has no layer shell";
  // Without the native half of the layer-shell path the window could only be
  // moved by the compositor, which a layer surface never is. `window.ts` logs
  // why; here the window simply stays an ordinary one.
  if (!isLayerShellNativeComplete) return "the native module is older";
  return null;
}

/** Which space the placement in use is measured in. */
function placementSpace(): PlacementSpace {
  return whyLayerShellIsUnavailable() === null ? "screen" : "desk";
}

/**
 * Give the lyrics window the overlay layer, where the compositor takes one.
 *
 * Returns whether it did; without a layer surface the window stays an ordinary
 * toplevel and keeps the window-manager rules the documentation describes.
 */
function useLyricsLayerShell(managed: ManagedWindow): boolean {
  const unavailable = whyLayerShellIsUnavailable();
  if (unavailable !== null) {
    LOGGER.info(
      { wrap: managed.id, reason: unavailable },
      "the desktop lyrics stay an ordinary window"
    );
    return false;
  }
  // The native layer replays the move and resize, so it is also the only thing
  // that knows where the surface ended up: the compositor does not tell clients
  // where their layer surfaces are. Subscribing once per wrapper, because the
  // on-demand lifecycle builds the window again on every show and a listener
  // added each time would report every event once per show so far.
  if (!subscribedToLayerEvents.has(managed)) {
    subscribedToLayerEvents.add(managed);
    managed.on("layerPushed", (event) => {
      // A window that is no longer the lyrics is not the one being dragged: a
      // window an earlier move left behind keeps reporting the edge it was
      // pushed against, and following that would move the lyrics back.
      if (managed !== window) return;
      void hopToNextScreen(event.data.edges);
    });
    managed.on("layerGeometry", (event) => {
      if (managed !== window) return;
      saveLyricsGeometry(event.data);
      requestScreenSize(managed);
    });
    managed.on("layerOutput", (event) => {
      // The native layer is the only thing that can say which screen a layer
      // surface was given, and it names it the way it wants it asked for.
      saveLyricsOutput(event.data.output);
      // Both of these say the surface is up, which is what the first report may
      // have been too early for.
      requestScreenSize(managed);
    });
  }
  const taken = managed.setLayerShell(lyricsLayerShellOptions());
  // Which of the two the window came out as is the first thing a report about
  // its drag turns on, and the other answer is logged for the same reason: with
  // a list of compositors in the way, "was it a layer surface at all" cannot be
  // read off the session.
  LOGGER.info(
    { wrap: managed.id, desktop: desktopName, taken },
    taken
      ? "the desktop lyrics take a layer surface"
      : "the layer surface was refused, so the desktop lyrics stay an ordinary window"
  );
  return taken;
}

function setupDesktopLyricsWindow(wnd: BrowserWindow, layerShell: boolean): BrowserWindow {
  const managed = ManagedWindow.fromBrowserWindow(wnd);
  const de = getDesktopEnvironment();
  void wnd.loadURL(guiUrl("/desktop-lyrics"));

  if (!layerShell && de !== DesktopEnvironment.Wayland) {
    // Without a layer surface the window manager places the window and tells
    // the client where it put it, so this is where the placement comes from —
    // and it is only worth reading where that happens at all: on Wayland a
    // client is never told where its own toplevel is, and `getBounds` answers
    // with a position nothing ever put it at.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        // A window the window manager placed is placed on the desk, so that is
        // the space its position is in — not one screen's own corner.
        if (!wnd.isDestroyed()) saveLyricsGeometry(wnd.getBounds(), "desk");
      }, LYRICS_GEOMETRY_SETTLE_MS);
    };
    wnd.on("moved", remember);
    wnd.on("resized", remember);
  }

  wnd.on("blur", () => {
    if (wnd.isDestroyed()) return;
    wnd.webContents.send("desktopLyrics.blur");
  });

  registerIpcHandlers<DesktopLyricsContract>(wnd.webContents, "desktopLyrics", {
    requestFullUpdate: async () => {
      if (wnd.isDestroyed()) return;
      // The page has mounted, which is the only report of a window being up:
      // a window built again is waited for on exactly this, before the one the
      // user was dragging is let go of.
      if (managed) reportPageIsUp(managed);
      // Can trigger updates
      refreshLyricsStyle();
      setLyricsOffset(lyricsOffset);
      setLyricsLocked(lyricsLocked);
      updateLyricsPlayInfo(lyricsPlayInfo);
    },
    performAction: async (_event, action: string) => {
      performAction(action);
    },
    reportScreenSize: async (_event, width: number, height: number) => {
      lyricsScreen = { width, height };
      managed?.setLayerBounds(width, height);
    },
    onMouseWheel: async (_event, pageX: number, pageY: number, delta: number, modifier = 0) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      let x = pageX;
      let y = pageY;
      if (de !== DesktopEnvironment.Wayland) {
        const scrCursor = screen.getCursorScreenPoint();
        [x, y] = [scrCursor.x, scrCursor.y];
      }
      mainWindow.webContents.send(
        "channel.call",
        "player.ondesktopmousewheel",
        modifier,
        delta,
        x,
        y
      );
    },
    changeOrientation: async (_event, vertical: boolean) => {
      if (wnd.isDestroyed()) return;
      const [width, height] = wnd.getSize();
      // The window is created at the size it was last left at, so a page that
      // has just mounted — a restart, a window shown again, one built again on
      // another screen — is already the way round the lyrics are laid out.
      // Swapping there would undo the size it was created with, so only the
      // other way round is a reason to swap.
      const isVertical = width < height;
      if (isVertical === vertical) return;
      // A layer surface is sized by the native layer, and the compositor's
      // configure resizes the window from there; anything else keeps resizing
      // itself.
      if (managed?.setLayerSize(height, width)) {
        saveLyricsGeometry({ ...lyricsGeometry, width: height, height: width });
      } else {
        wnd.setSize(height, width);
      }
    },
    dragWindow: async () => {
      if (wnd.isDestroyed()) return;
      const hwnd = wnd.getNativeWindowHandle();
      dragWindow(hwnd);
    },
  });
  registerInputRegionHandlers(wnd);
  registerLyricsHandlers(wnd);
  registerSettingsHandlers(wnd);

  return wnd;
}

/** Closing the window tells the player to hide the lyrics instead. */
function notifyDesktopLyricsClose() {
  performAction("close");
}

class DesktopLyricsWindow extends ManagedWindow {
  constructor() {
    super();
    this.setData("name", "desktop_lyrics");
    this.requestCloseApproval(notifyDesktopLyricsClose);
    // Before the window: the role is decided when the surface's first role
    // object is created, which `createBrowserWindow` can already do.
    const layerShell = useLyricsLayerShell(this);
    setupDesktopLyricsWindow(
      this.createBrowserWindow(desktopLyricsWindowOptions(layerShell)),
      layerShell
    );
  }
}

class DesktopLyricsOnDemandWindow extends OnDemandWindow {
  constructor() {
    super();
    this.setData("name", "desktop_lyrics");
    this.requestCloseApproval(notifyDesktopLyricsClose);
  }

  createWindow(): BrowserWindow {
    const layerShell = useLyricsLayerShell(this);
    return setupDesktopLyricsWindow(
      this.createBrowserWindow(desktopLyricsWindowOptions(layerShell)),
      layerShell
    );
  }
}

/** `"on-demand"` destroys the window when hidden; anything else keeps it. */
function createWindowForLifecycle(value: unknown): ManagedWindow {
  return value === "on-demand" ? new DesktopLyricsOnDemandWindow() : new DesktopLyricsWindow();
}

let lifecycleSwitchRegistered = false;

/**
 * React to lifecycle changes without a restart.
 *
 * Registered from the startup path rather than at module scope: this module can
 * be evaluated before `settings.initialize()` creates the settings emitter.
 */
function registerLifecycleSwitch() {
  if (lifecycleSwitchRegistered) return;
  lifecycleSwitchRegistered = true;

  settingsEvents.on("change", (e) => {
    if (e.data.key !== "window.lifecycle" || !window) return;
    // A move to another screen that is still building its window is stopped
    // first: it is the wrapper this switch is about to replace, and a
    // replacement that outlives the move would leave two windows and one name
    // between them. Stopped rather than waited for, so the switch starts from
    // the window the user is actually looking at.
    abandonPendingMove?.();
    window = switchWindowPolicy(window, () => createWindowForLifecycle(e.data.value));
  });
}

export let window: ManagedWindow;
export default async function createDesktopLyricsWindow() {
  await loadLyricsGeometry();
  window = createWindowForLifecycle(await settings.get("window.lifecycle"));
  registerLifecycleSwitch();
}

// --- Preview ---

/** Offscreen window used only to rasterise a lyrics preview. */
class LyricsPreviewWindow extends ManagedWindow {
  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.createBrowserWindow(options);
  }
}

export async function createDesktopLyricsPreview(
  style: LyricsStyle,
  text: string
): Promise<[Buffer, [number, number]]> {
  const [width, height] = style.vertical ? [124, 310] : [310, 124];

  const previewWindow = new LyricsPreviewWindow({
    width,
    height,
    show: false,
    transparent: true,
    hasShadow: false,
    frame: false,
    resizable: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      partition: "open-orpheus",
      preload: join(import.meta.dirname, "desktop-lyrics-preview.cjs"),
    },
  }).window;
  if (!previewWindow) {
    throw new Error("Preview window was not created");
  }

  return new Promise<[Buffer, [number, number]]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!previewWindow.isDestroyed()) previewWindow.close();
      reject(new Error("Preview generation timed out"));
    }, 10000);

    registerIpcHandlers<DesktopLyricsPreviewContract>(
      previewWindow.webContents,
      "desktopLyricsPreview",
      {
        requestInit: async () => ({ style, text }),
        ready: async () => {
          clearTimeout(timeout);
          try {
            const image = await previewWindow.webContents.capturePage();
            const photonImage = photon.PhotonImage.new_from_byteslice(image.toPNG());
            const pngBuf = photon
              .resize(photonImage, width, height, photon.SamplingFilter.Lanczos3)
              .get_bytes();
            resolve([Buffer.from(pngBuf), [width, height]]);
          } catch (err) {
            reject(err);
          } finally {
            setImmediate(() => previewWindow.close());
          }
        },
      }
    );

    void previewWindow.loadURL(guiUrl("/desktop-lyrics-preview"));
  });
}
