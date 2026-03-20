import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: "../.vite/build/gui",
    }),
  },
  vitePlugin: {
    dynamicCompileOptions: ({ filename }: { filename: string }) =>
      filename.includes("node_modules") ? undefined : { runes: true },
  },
};

export default config;
