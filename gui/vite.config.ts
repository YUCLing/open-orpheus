import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  ssr: {
    noExternal: ["@lucide/svelte"],
  },
  server: {
    hmr: {
      // Avoid conflict with dummy Vite HMR endpoint used by Electron Forge
      path: "sveltekit-hmr",
    },
  },
});
