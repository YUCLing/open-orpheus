// This module is the CJS entry point for the library.

import App from "./App.cjs";
import LyricsWindow from "./LyricsWindow.cjs";
import Menu from "./Menu.cjs";
import { getSystemFonts } from "./module.cjs";

export type { LyricsStyleDto } from "./LyricsWindow.cjs";
export { App, LyricsWindow, Menu, getSystemFonts };
