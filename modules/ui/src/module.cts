// The Rust addon.
import * as addon from "./load.cjs";

// Use this declaration to assign types to the addon's exports,
// which otherwise by default are `any`.
declare module "./load.cjs" {
  function createApp(): number;
  function createWindow(appPtr: number): number;
  function createMenu(): number;
  function showMenu(menuPtr: number): void;
}

export = addon;
