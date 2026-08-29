import { describe, expect, it } from "vitest";

import { generateDesktop } from "../../packaging/common/desktop.js";

describe("Desktop file generation", async () => {
  it("generates with default options", async () => {
    const generated = await generateDesktop();
    expect(generated).toMatchSnapshot();
  });

  it("generates with custom executable name", async () => {
    const generated = await generateDesktop({
      executable: "zypak-wrapper",
    });
    expect(generated).toMatchSnapshot();
  });
});
