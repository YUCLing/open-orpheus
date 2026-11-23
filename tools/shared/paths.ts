import { resolve } from "node:path";

/**
 * Canonical project paths for build tooling.
 *
 * Every tool lives below `tools/`, but the project itself is two levels up.
 * Keeping the derivation here means moving a script between `tools/`
 * subdirectories never changes which tree it operates on.
 */
export const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
export const SRC_DIR = resolve(PROJECT_ROOT, "src");
export const TOOLS_DIR = resolve(PROJECT_ROOT, "tools");
export const OUT_DIR = resolve(PROJECT_ROOT, "out");
export const TESTS_DIR = resolve(PROJECT_ROOT, "__test__");
