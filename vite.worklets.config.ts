import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "worklets/[name].js",
        assetFileNames: "worklets/assets/[name][extname]",
      },
    },
  },
});
