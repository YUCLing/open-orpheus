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

  function createLyricsWindow(
    appPtr: number,
    show: boolean
  ): Promise<[number, number]>;
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
  function setLyricsStyle(
    ptr: number,
    style: {
      not_played_top?: [number, number, number];
      not_played_bottom?: [number, number, number];
      played_top?: [number, number, number];
      played_bottom?: [number, number, number];
      outline_color_not_played?: [number, number, number];
      outline_color_played?: [number, number, number];
      outline_width?: number;
      shadow_enabled?: boolean;
      shadow_blur_radius?: number;
      shadow_offset?: [number, number];
      shadow_color?: [number, number, number, number];
      font_family?: string;
      font_size?: number;
      bold?: boolean;
      text_align?: [string, string];
      line_mode?: string;
      show_horizontal?: boolean;
      offset_ms?: number;
      secondary_font_scale?: number;
    }
  ): void;

  function focusWindow(appPtr: number, windowId: number): void;
  function showWindow(appPtr: number, windowId: number): void;
  function hideWindow(appPtr: number, windowId: number): void;
  function setAlwaysOnTop(
    appPtr: number,
    windowId: number,
    onTop: boolean
  ): void;
  function setWindowBounds(
    appPtr: number,
    windowId: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): void;
  function dragWindow(appPtr: number, windowId: number): void;
}

export = addon;
