import { resolve } from "node:path";

import { build, createServer } from "vite";

const GUI_DIR = resolve(import.meta.dirname, "../gui");
const GUI_CONFIG_FILE = resolve(GUI_DIR, "vite.config.ts");

const verb = process.argv[process.argv.length - 1];
const originalCwd = process.cwd();

process.chdir(GUI_DIR);
process.on("beforeExit", () => process.chdir(originalCwd));

process.on("disconnect", () => {
  // Die with parent process
  process.exit(0);
});

switch (verb) {
  case "build":
    await build({
      configFile: GUI_CONFIG_FILE,
    }).catch((e) => {
      process.send?.(String(e));
      throw e;
    });
    process.send?.("DONE");
    process.exit();
    break;
  case "dev": {
    const server = await createServer({
      configFile: GUI_CONFIG_FILE,
    });
    await server.listen(parseInt(process.env["DEV_PORT"] ?? "") ?? 5173);
    process.send?.("READY");
    break;
  }
  default:
    console.error("Invalid verb");
}
