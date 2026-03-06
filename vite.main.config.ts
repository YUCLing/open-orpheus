import { defineConfig } from "vite";

// unzipper has a dependency on @aws-sdk/client-s3, which is not needed in
// our context and causes build issues. This plugin mocks it out.
function NoS3Plugin() {
  return {
    name: "no-s3",
    resolveId(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return id; // Mark as resolved but empty
      }
    },
    load(id: string) {
      if (id === "@aws-sdk/client-s3") {
        return "export default {}"; // Provide an empty module
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["font-list", "database", "window"],
    },
  },
  plugins: [NoS3Plugin()],
});
