import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      ".vite/**",
      "out/**",
      "**/node_modules/**",
      "**/.svelte-kit/**",
      "modules/**/lib/**",
      "data/**",
    ],
  },
  js.configs.recommended,
  tsPlugin.configs["flat/eslint-recommended"],
  ...tsPlugin.configs["flat/recommended"],
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
  eslintConfigPrettier,
];
