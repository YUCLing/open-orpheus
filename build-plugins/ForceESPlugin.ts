import { Plugin } from "vite";

/**
 * Force Electron Forge's output format to be ESM
 */
export default function ForceESPlugin(): Plugin {
  return {
    name: "force-es-plugin",
    config(config) {
      config.build = {
        ...config.build,
        rolldownOptions: {
          ...config.build?.rolldownOptions,
          platform: "node",
        },
      };
      const lib = config.build.lib;
      if (lib) {
        lib.formats = ["es"];
      }
      const output = config.build.rollupOptions?.output;
      if (output) {
        const outputs = Array.isArray(output) ? output : [output];
        outputs.forEach((v) => {
          v.format = "es";
        });
      }
    },
  };
}
