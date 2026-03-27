// The Rust addon.
import * as addon from "./load.cjs";

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function createApp(options: {
    preferWayland?: boolean | null;
    readWebPack: (path: string) => Promise<Buffer>;
    readSkinPack: (path: string) => Promise<Buffer>;
  }): [number, number];
  function destroyApp(appPtr: number, checkPtr: number): void;
  function loadMenuSkin(appPtr: number, path: string): Promise<void>;

  function createWindow(appPtr: number): number;
  // TODO: Types
  function destroyMenu(menuPtr: number): void;
  function createMenu(appPtr: number, menuData: unknown): number;
  function showMenu(menuPtr: number): void;
  function setMenuOnClick(
    menuPtr: number,
    callback: (id: string) => void
  ): void;
  function updateMenuItem(menuPtr: number, item: unknown): void;

  function getSystemFonts(): string[];

  // ── OSR window ───────────────────────────────────────────────────────────
  function createOsrWindow(
    appPtr: number,
    options: {
      width: number;
      height: number;
      transparent?: boolean;
      resizable?: boolean;
      alwaysOnTop?: boolean;
      skipTaskbar?: boolean;
      title?: string;
    }
  ): Promise<number>;
  function osrWindowUpdateFrame(
    windowPtr: number,
    buffer: Buffer,
    width: number,
    height: number
  ): void;
  function osrWindowSetInputHandler(
    windowPtr: number,
    callback: (eventJson: string) => void
  ): void;
  function osrWindowResize(
    windowPtr: number,
    width: number,
    height: number
  ): void;
  function osrWindowSetCursor(windowPtr: number, cursorName: string): void;
  function osrWindowDrag(windowPtr: number): void;
  function osrWindowClose(windowPtr: number): void;
  function destroyOsrWindow(windowPtr: number): void;
}

export = addon;
