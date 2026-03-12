// Script for early-state development of the UI module.

import { App } from "@open-orpheus/ui";

const app = new App();

app.createWindow();

setInterval(() => {
  // keep alive
}, 1000);
