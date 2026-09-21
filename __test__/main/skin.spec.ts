import { describe, expect, it, vi } from "vitest";

import { extractColor } from "@main/skin/color";
import {
  abgrToCss,
  argbToCss,
  parseBtnState,
  parseBtnUrl,
  parseElementTemplate,
} from "@main/skin/dui";

/** Minimal stand-in for a `photon.PhotonImage` backed by raw RGBA bytes. */
function fakeImage(width: number, height: number, pixels: number[]) {
  return {
    get_width: () => width,
    get_height: () => height,
    get_raw_pixels: () => new Uint8Array(pixels),
  } as unknown as Parameters<typeof extractColor>[0];
}

describe("extractColor", () => {
  it("reads the centre pixel as #rrggbbaa", async () => {
    const image = fakeImage(
      2,
      2,
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]
    );

    await expect(extractColor(image)).resolves.toBe("#01020304");
  });

  it("picks the centre of odd sized images", async () => {
    const pixels = new Array(3 * 3 * 4).fill(0);
    const centre = (1 * 3 + 1) * 4;
    pixels.splice(centre, 4, 0xab, 0xcd, 0xef, 0xff);

    await expect(extractColor(fakeImage(3, 3, pixels))).resolves.toBe(
      "#abcdefff"
    );
  });

  it("reads the only pixel of a 1x1 image", async () => {
    await expect(
      extractColor(fakeImage(1, 1, [255, 0, 128, 255]))
    ).resolves.toBe("#ff0080ff");
  });

  it("falls back to opaque black when there is no pixel data", async () => {
    await expect(extractColor(fakeImage(0, 0, []))).resolves.toBe("#000000ff");
  });
});

describe("argbToCss / abgrToCss", () => {
  it("reorders ARGB into CSS RRGGBBAA", () => {
    expect(argbToCss("#ff112233")).toBe("#112233ff");
    expect(argbToCss("#7fabcd12")).toBe("#abcd127f");
  });

  it("reorders ABGR into CSS RRGGBBAA", () => {
    expect(abgrToCss("#ff332211")).toBe("#112233ff");
    expect(abgrToCss("#283248ff")).toBe("#ff483228");
  });

  it("passes through values that are not 8-digit hex colours", () => {
    expect(argbToCss("#fff")).toBe("#fff");
    expect(argbToCss("red")).toBe("red");
    expect(abgrToCss("rgb(1,2,3)")).toBe("rgb(1,2,3)");
    expect(abgrToCss("112233ff")).toBe("112233ff");
  });
});

describe("parseBtnState", () => {
  it("parses a file and an ABGR colour", () => {
    expect(parseBtnState("file='btn/play.svg' svg_color='#ff483228'")).toEqual({
      uri: "btn/play.svg",
      color: "#283248ff",
    });
  });

  it("allows a missing colour", () => {
    expect(parseBtnState("file='btn/play.png'")).toEqual({
      uri: "btn/play.png",
      color: undefined,
    });
  });

  it("returns null without a file attribute", () => {
    expect(parseBtnState("svg_color='#ff483228'")).toBeNull();
    expect(parseBtnState("")).toBeNull();
  });
});

describe("parseBtnUrl", () => {
  it("parses the four button states", () => {
    expect(
      parseBtnUrl(
        "normalimage=\"file='n.svg'\" hotimage=\"file='h.svg'\" " +
          "pushedimage=\"file='p.svg'\" disabledimage=\"file='d.svg'\""
      )
    ).toEqual({
      normal: { uri: "n.svg", color: undefined },
      hot: { uri: "h.svg", color: undefined },
      pushed: { uri: "p.svg", color: undefined },
      disabled: { uri: "d.svg", color: undefined },
    });
  });

  it("only fills in the states that are present", () => {
    const images = parseBtnUrl("normalimage=\"file='n.svg'\"");
    expect(images).toEqual({
      normal: { uri: "n.svg", color: undefined },
      hot: undefined,
      pushed: undefined,
      disabled: undefined,
    });
  });

  it("requires a normal image", () => {
    expect(parseBtnUrl("hotimage=\"file='h.svg'\"")).toBeNull();
    expect(parseBtnUrl("")).toBeNull();
  });
});

describe("parseElementTemplate", () => {
  const xml = `
<MenuElement height="40" minwidth="120" maxwidth="600">
  <MenuElementLayout>
    <Button width="32" height="32" />
    <VerticalLayout>
      <Button />
      <Control width="10" height="12" />
      <MenuButton />
      <MenuLabel />
    </VerticalLayout>
  </MenuElementLayout>
</MenuElement>`;

  it("parses sizes and the layout tree", () => {
    expect(parseElementTemplate(xml)).toEqual({
      height: 40,
      minWidth: 120,
      maxWidth: 600,
      layout: {
        type: "horizontal",
        children: [
          { type: "button", width: 32, height: 32, index: 0 },
          {
            type: "vertical",
            children: [
              { type: "button", width: 24, height: 24, index: 1 },
              { type: "control", width: 10, height: 12 },
            ],
          },
        ],
      },
    });
  });

  it("falls back to the default element sizes", () => {
    const parsed = parseElementTemplate(
      "<MenuElement><MenuElementLayout /></MenuElement>"
    );

    expect(parsed).toEqual({
      height: 30,
      minWidth: 0,
      maxWidth: 300,
      layout: { type: "horizontal", children: [] },
    });
  });

  it("supports containers", () => {
    const parsed = parseElementTemplate(
      "<MenuElement><MenuElementLayout><Container width='5' height='6'/></MenuElementLayout></MenuElement>"
    );

    expect(parsed).toEqual({
      height: 30,
      minWidth: 0,
      maxWidth: 300,
      layout: {
        type: "horizontal",
        children: [{ type: "container", width: 5, height: 6, children: [] }],
      },
    });
  });

  it("returns null when the expected elements are missing", () => {
    expect(parseElementTemplate("")).toBeNull();
    expect(parseElementTemplate("<Root />")).toBeNull();
    expect(parseElementTemplate("<MenuElement />")).toBeNull();
  });

  it("stays quiet when the XML cannot be parsed", () => {
    // xmldom reports parse failures through `console.error` by default.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(parseElementTemplate("")).toBeNull();
      expect(parseElementTemplate("<MenuElement>")).toBeNull();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
