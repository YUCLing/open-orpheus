import { afterEach, describe, expect, it, vi } from "vitest";

import { checkEnvFlagPresent } from "@main/platform/utils/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkEnvFlagPresent", () => {
  it("accepts `1` and `true`", () => {
    vi.stubEnv("ORPHEUS_TEST_FLAG", "1");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(true);

    vi.stubEnv("ORPHEUS_TEST_FLAG", "true");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(true);
  });

  it("rejects other values and unset variables", () => {
    vi.stubEnv("ORPHEUS_TEST_FLAG", "0");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(false);

    vi.stubEnv("ORPHEUS_TEST_FLAG", "yes");
    expect(checkEnvFlagPresent("ORPHEUS_TEST_FLAG")).toBe(false);

    expect(checkEnvFlagPresent("ORPHEUS_UNSET_FLAG")).toBe(false);
  });
});
