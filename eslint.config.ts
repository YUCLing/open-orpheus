import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import eslintConfigPrettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";

export default [
  {
    ignores: [
      ".vite/**",
      "out/**",
      "**/node_modules/**",
      "**/.svelte-kit/**",
      "modules/**/dist/**",
      "modules/**/index.d.ts",
      "data/**",
    ],
  },
  js.configs.recommended,
  tsPlugin.configs["flat/eslint-recommended"],
  ...(tsPlugin.configs["flat/recommended"] as unknown[]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.electron,
  importPlugin.flatConfigs.typescript,
  {
    settings: {
      "import/resolver": {
        typescript: true,
        node: true,
      },
    },
  },
  {
    files: ["modules/**/*.{ts,tsx,cts,mts}"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["gui/**/*.{svelte,ts,js}"],
    languageOptions: {
      globals: {
        __APP_VERSION__: "readonly",
        orpheus: "readonly",
        kv: "readonly",
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "gui/tsconfig.json",
        },
      },
    },
  },
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
      },
    },
    rules: {
      "import/namespace": "off",
      "import/no-duplicates": "off",
    },
  },
  eslintConfigPrettier,
  ...svelte.configs["flat/prettier"],
];
