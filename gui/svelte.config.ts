import adapter from "@sveltejs/adapter-static";
import type { Config } from "@sveltejs/kit";

const config: Config = {
  kit: {
    adapter: adapter({
      pages: "../.vite/build/gui",
    }),
    alias: {
      $bridge: "../src/bridge",
      "@shared": "../src/shared",
    },
  },
  vitePlugin: {
    dynamicCompileOptions: ({ filename }: { filename: string }) =>
      filename.includes("node_modules") ? undefined : { runes: true },
  },
};

export default config;
