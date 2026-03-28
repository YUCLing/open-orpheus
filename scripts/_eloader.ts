/* eslint-disable */
// @ts-nocheck

import { dirname, join } from "node:path";

import { registerExtensionlessLoader } from "./_loader.ts";

registerExtensionlessLoader({
  loaderUrl: join(dirname(import.meta.url), "_loader.ts"),
});
