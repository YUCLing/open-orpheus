import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isDefaultProtocolClient: vi.fn(() => false),
    getApplicationNameForProtocol: vi.fn(() => ""),
    setAsDefaultProtocolClient: vi.fn(() => true),
    removeAsDefaultProtocolClient: vi.fn(() => true),
  },
}));

import { app } from "electron";

import registerAsProtocolClient, {
  checkOpenCommand,
  getProtocolClientName,
  isProtocolClient,
  unregisterAsProtocolClient,
} from "@main/protocol";

describe("checkOpenCommand", () => {
  it("finds an orpheus URL in the argv", () => {
    expect(checkOpenCommand(["/usr/bin/open-orpheus", "orpheus://x/y"])).toBe(
      "orpheus://x/y"
    );
  });

  it("returns the first orpheus URL", () => {
    expect(checkOpenCommand(["orpheus://first", "orpheus://second"])).toBe(
      "orpheus://first"
    );
  });

  it("returns null when nothing matches", () => {
    expect(checkOpenCommand(["--flag", "file.txt"])).toBeNull();
    expect(checkOpenCommand([])).toBeNull();
    expect(checkOpenCommand(["notorpheus://x"])).toBeNull();
  });

  it("falls back to the process argv", () => {
    const original = process.argv;
    process.argv = ["node", "main.js", "orpheus://from-process-argv"];
    try {
      expect(checkOpenCommand()).toBe("orpheus://from-process-argv");
    } finally {
      process.argv = original;
    }
  });
});

describe("registerAsProtocolClient", () => {
  beforeEach(() => {
    vi.mocked(app.isDefaultProtocolClient).mockReset().mockReturnValue(false);
    vi.mocked(app.getApplicationNameForProtocol)
      .mockReset()
      .mockReturnValue("");
    vi.mocked(app.setAsDefaultProtocolClient).mockReset().mockReturnValue(true);
    vi.mocked(app.removeAsDefaultProtocolClient)
      .mockReset()
      .mockReturnValue(true);
  });

  it("does nothing when the app already owns the scheme", () => {
    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(true);

    expect(registerAsProtocolClient()).toBe(false);
    expect(isProtocolClient()).toBe(true);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("does nothing when another application owns the scheme", () => {
    vi.mocked(app.getApplicationNameForProtocol).mockReturnValue(
      "Some Other App"
    );

    expect(registerAsProtocolClient()).toBe(false);
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("registers when the scheme is unclaimed", () => {
    expect(registerAsProtocolClient()).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("orpheus");
  });

  it("overrides another owner when forced", () => {
    vi.mocked(app.getApplicationNameForProtocol).mockReturnValue(
      "Some Other App"
    );

    expect(registerAsProtocolClient(true)).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith("orpheus");
  });

  it("exposes the other application handling the scheme", () => {
    vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("Firefox");

    expect(getProtocolClientName()).toBe("Firefox");
    expect(app.getApplicationNameForProtocol).toHaveBeenCalledWith(
      "orpheus://"
    );
  });
});

describe("unregisterAsProtocolClient", () => {
  beforeEach(() => {
    vi.mocked(app.isDefaultProtocolClient).mockReset().mockReturnValue(false);
    vi.mocked(app.removeAsDefaultProtocolClient)
      .mockReset()
      .mockReturnValue(true);
  });

  it("does nothing when the app is not the default client", () => {
    expect(unregisterAsProtocolClient()).toBe(false);
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("removes the registration when the app owns the scheme", () => {
    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(true);

    expect(unregisterAsProtocolClient()).toBe(true);
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith("orpheus");
  });
});
