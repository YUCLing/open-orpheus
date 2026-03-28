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

  function createLyricsWindow(appPtr: number): Promise<number>;
  function destroyLyricsWindow(ptr: number): void;
  function setLyricsData(
    ptr: number,
    data: {
      lines: {
        start_time: number;
        end_time: number;
        words: { text: string; start_time: number; duration: number }[];
      }[];
      secondary_lines?: {
        start_time: number;
        end_time: number;
        words: { text: string; start_time: number; duration: number }[];
      }[];
    } | null
  ): void;
  function setLyricsTime(ptr: number, timeMs: number): void;
}

export = addon;
