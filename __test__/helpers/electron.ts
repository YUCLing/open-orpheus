import { vi } from "vitest";

/**
 * The real `electron` package resolves to the executable path outside Electron,
 * and Electron 45 downloads the binary if it is missing. Unit tests have no use
 * for that side effect, so a bare import is a missing mock rather than a
 * meaningful dependency: fail loudly instead of downloading Electron.
 *
 * A test that needs Electron APIs must still provide its own `vi.mock("electron")`
 * (or mock the module that imports it); that local mock takes precedence.
 */
vi.mock("electron", () => {
  throw new Error(
    "Unexpected import of the real `electron` package in a unit test. " +
      "Mock `electron` or the module that imports it in this test."
  );
});
