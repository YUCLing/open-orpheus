import { beforeEach, describe, expect, it, vi } from "vitest";

// memfs-backed, see `__mocks__/fs/promises.cts`.
vi.mock("node:fs/promises");

import { readFile } from "node:fs/promises";

import { vol } from "memfs";

import {
  createControlFile,
  generateControl,
  resolveControlOptions,
  type ControlOptions,
} from "../../packaging/deb/control";

const pkg = {
  name: "open-orpheus",
  author: { name: "YUCLing", email: "luotianyi@luotianyi.me" },
  homepage: "https://github.com/YUCLing/open-orpheus",
  description: "An open-source implementation.\nIt plays music.",
};

const options: ControlOptions = {
  name: "open-orpheus",
  section: "sound",
  maintainer: "YUCLing <luotianyi@luotianyi.me>",
  homepage: "https://github.com/YUCLing/open-orpheus",
  description: "An open-source implementation.\n It plays music.",
};

describe("resolveControlOptions", () => {
  it("takes everything from package.json by default", () => {
    expect(resolveControlOptions({}, pkg)).toEqual({
      name: "open-orpheus",
      section: "sound",
      maintainer: "YUCLing <luotianyi@luotianyi.me>",
      homepage: "https://github.com/YUCLing/open-orpheus",
      // Continuation lines get the Debian field indent.
      description: "An open-source implementation.\n It plays music.",
    });
  });

  it("prefers explicit options over package.json", () => {
    expect(
      resolveControlOptions(
        {
          name: "custom-app",
          section: "utils",
          maintainer: "Someone <a@b.c>",
          homepage: "https://example.test",
          description: "Custom.",
        },
        pkg
      )
    ).toEqual({
      name: "custom-app",
      section: "utils",
      maintainer: "Someone <a@b.c>",
      homepage: "https://example.test",
      description: "Custom.",
    });
  });

  it("formats an object author as `Name <email>`", () => {
    expect(
      resolveControlOptions({}, { author: { name: "A", email: "a@b.c" } })
        .maintainer
    ).toBe("A <a@b.c>");
  });

  it("uses a string author verbatim", () => {
    expect(resolveControlOptions({}, { author: "A <a@b.c>" }).maintainer).toBe(
      "A <a@b.c>"
    );
  });

  it("drops a missing email", () => {
    expect(
      resolveControlOptions({}, { author: { name: "A" } }).maintainer
    ).toBe("A");
  });

  it("falls back to open-orpheus defaults when metadata is missing", () => {
    expect(resolveControlOptions({}, {})).toEqual({
      name: "open-orpheus",
      section: "sound",
      maintainer: "",
      homepage: "",
      description: "",
    });
  });

  it("only indents continuation lines of a multi-line description", () => {
    expect(
      resolveControlOptions({}, { description: "one\ntwo\nthree" }).description
    ).toBe("one\n two\n three");
    expect(
      resolveControlOptions({}, { description: "single line" }).description
    ).toBe("single line");
  });
});

describe("generateControl", () => {
  it("renders a debian/control file", async () => {
    const control = await generateControl(options);

    expect(control).toContain("Source: open-orpheus");
    expect(control).toContain("Section: sound");
    expect(control).toContain("Priority: optional");
    expect(control).toContain("Maintainer: YUCLing <luotianyi@luotianyi.me>");
    expect(control).toContain(
      "Homepage: https://github.com/YUCLing/open-orpheus"
    );
    expect(control).toContain("Package: open-orpheus");
    expect(control).toContain("Architecture: any");
    expect(control).toContain("Description: An open-source implementation.");
    expect(control).toContain("\n It plays music.");
  });

  it("declares the build and runtime dependencies", async () => {
    const control = await generateControl(options);

    expect(control).toContain("Build-Depends: debhelper-compat (= 13)");
    expect(control).toContain("Rules-Requires-Root: no");
    expect(control).toContain("Depends: ${misc:Depends}");
  });

  it("escapes nothing, so HTML-ish text survives", async () => {
    const control = await generateControl({
      ...options,
      description: "Uses <kbd>a</kbd> & b",
    });

    expect(control).toContain("Description: Uses <kbd>a</kbd> & b");
  });

  it("renders the options it is given, not package.json", async () => {
    const control = await generateControl({ ...options, name: "other-app" });

    expect(control).toContain("Source: other-app");
    expect(control).not.toContain("Source: open-orpheus");
  });
});

describe("createControlFile", () => {
  beforeEach(() => {
    vol.reset();
    vol.mkdirSync("/stage/debian", { recursive: true });
  });

  it("writes the rendered control file", async () => {
    await createControlFile("/stage/debian/control", options);

    await expect(readFile("/stage/debian/control", "utf-8")).resolves.toContain(
      "Package: open-orpheus"
    );
  });

  it("creates missing directories through the caller's staging", async () => {
    await expect(
      createControlFile("/missing/parent/control", options)
    ).rejects.toThrow();

    vol.mkdirSync("/missing/parent", { recursive: true });
    await createControlFile("/missing/parent/control", options);

    expect(vol.existsSync("/missing/parent/control")).toBe(true);
  });
});
