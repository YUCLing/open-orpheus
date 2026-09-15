import { describe, expect, it } from "vitest";

import { parseFlags } from "../../packaging/common/cli";

describe("parseFlags", () => {
  it("defaults to a clean, toolchain-less, non-prebuilt build", () => {
    expect(parseFlags([])).toEqual({
      installTools: false,
      nodeps: false,
      prebuilt: false,
      clean: true,
      arch: undefined,
    });
  });

  it("parses each flag", () => {
    expect(parseFlags(["--install-tools"])).toMatchObject({
      installTools: true,
    });
    expect(parseFlags(["--nodeps"])).toMatchObject({ nodeps: true });
    expect(parseFlags(["--prebuilt"])).toMatchObject({ prebuilt: true });
    expect(parseFlags(["--no-clean"])).toMatchObject({ clean: false });
  });

  it("parses --arch with its value", () => {
    expect(parseFlags(["--arch", "arm64"]).arch).toBe("arm64");
  });

  it("combines several flags", () => {
    expect(
      parseFlags(["--prebuilt", "--nodeps", "--arch", "x64", "--no-clean"])
    ).toEqual({
      installTools: false,
      nodeps: true,
      prebuilt: true,
      clean: false,
      arch: "x64",
    });
  });

  it("ignores unknown arguments", () => {
    expect(parseFlags(["--version", "extra", "-h"])).toEqual({
      installTools: false,
      nodeps: false,
      prebuilt: false,
      clean: true,
      arch: undefined,
    });
  });

  it("leaves --arch undefined when its value is missing", () => {
    expect(parseFlags(["--arch"]).arch).toBeUndefined();
    expect(parseFlags(["--arch", "--nodeps"])).toMatchObject({
      arch: "--nodeps",
      nodeps: false,
    });
  });

  it("is not confused by repeated flags", () => {
    expect(parseFlags(["--no-clean", "--no-clean"])).toMatchObject({
      clean: false,
    });
    expect(parseFlags(["--arch", "x64", "--arch", "arm64"]).arch).toBe("arm64");
  });
});
