import { exposeApi } from "../preload/bridge";

exposeApi("menu", {
  wayland: process.argv.includes("--wayland"),
  submenu: process.argv.includes("--submenu"),
});
exposeApi("inputRegion", {
  platform: process.platform,
});
