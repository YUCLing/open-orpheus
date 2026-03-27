// This module is the CJS entry point for the library.

import App from "./App.cjs";
import Menu from "./Menu.cjs";
import OsrWindow from "./OsrWindow.cjs";
import type { OsrWindowOptions, OsrInputEvent } from "./OsrWindow.cjs";
import { getSystemFonts } from "./module.cjs";

export { App, Menu, OsrWindow, getSystemFonts };
export type { OsrWindowOptions, OsrInputEvent };
