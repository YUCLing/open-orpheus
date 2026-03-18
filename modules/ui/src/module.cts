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
  function loadSkin(appPtr: number, path: string): Promise<void>;
  function createWindow(appPtr: number): number;
  // TODO: Types
  function destroyMenu(menuPtr: number): void;
  function createMenu(appPtr: number, menuData: any): number;
  function showMenu(menuPtr: number): void;
  function setMenuOnClick(
    menuPtr: number,
    callback: (id: string) => void
  ): void;
}

export = addon;
