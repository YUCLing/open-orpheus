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
  getProtocolClientName,
  isProtocolClient,
  unregisterAsProtocolClient,
} from "../../src/main/protocol";

// Command line parsing no longer lives here: `checkOpenCommand` moved to
// `src/main/arguments.ts` and is covered by `arguments.spec.ts`. This file only
// covers the protocol registration helpers.

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
