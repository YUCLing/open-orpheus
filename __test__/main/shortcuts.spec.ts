import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
  },
}));

import { globalShortcut } from "electron";

import {
  registerGlobalShortcut,
  unregisterGlobalShortcut,
  vkCodesToElectronAccelerator,
} from "@main/shortcuts";
import { installLoggerStub } from "../helpers/globals";

describe("vkCodesToElectronAccelerator", () => {
  it("maps modifiers and letters", () => {
    expect(vkCodesToElectronAccelerator([17, 18, 76])).toEqual({
      accelerator: "Control+Alt+L",
      unsupportedVkCodes: [],
    });
  });

  it("orders modifiers as Control, Alt, Shift, Super", () => {
    expect(vkCodesToElectronAccelerator([93, 16, 18, 17, 88]).accelerator).toBe(
      "Control+Alt+Shift+Super+X"
    );
  });

  it("maps digits, numpad keys and function keys", () => {
    expect(vkCodesToElectronAccelerator([48]).accelerator).toBe("0");
    expect(vkCodesToElectronAccelerator([57]).accelerator).toBe("9");
    expect(vkCodesToElectronAccelerator([96]).accelerator).toBe("num0");
    expect(vkCodesToElectronAccelerator([105]).accelerator).toBe("num9");
    expect(vkCodesToElectronAccelerator([112]).accelerator).toBe("F1");
    expect(vkCodesToElectronAccelerator([135]).accelerator).toBe("F24");
  });

  it("maps named and media keys", () => {
    expect(vkCodesToElectronAccelerator([8]).accelerator).toBe("Backspace");
    expect(vkCodesToElectronAccelerator([13]).accelerator).toBe("Enter");
    expect(vkCodesToElectronAccelerator([27]).accelerator).toBe("Escape");
    expect(vkCodesToElectronAccelerator([32]).accelerator).toBe("Space");
    expect(vkCodesToElectronAccelerator([37]).accelerator).toBe("Left");
    expect(vkCodesToElectronAccelerator([46]).accelerator).toBe("Delete");
    expect(vkCodesToElectronAccelerator([179]).accelerator).toBe(
      "MediaPlayPause"
    );
    expect(vkCodesToElectronAccelerator([177]).accelerator).toBe(
      "MediaPreviousTrack"
    );
  });

  it("keeps the last non-modifier key as the trigger", () => {
    expect(vkCodesToElectronAccelerator([65, 66]).accelerator).toBe("B");
    expect(vkCodesToElectronAccelerator([17, 65, 66]).accelerator).toBe(
      "Control+B"
    );
  });

  it("returns no accelerator when only modifiers are given", () => {
    expect(vkCodesToElectronAccelerator([17, 18])).toEqual({
      accelerator: null,
      unsupportedVkCodes: [],
    });
    expect(vkCodesToElectronAccelerator([])).toEqual({
      accelerator: null,
      unsupportedVkCodes: [],
    });
  });

  it("collects unsupported keys but still builds an accelerator", () => {
    expect(vkCodesToElectronAccelerator([17, 186, 76])).toEqual({
      accelerator: "Control+L",
      unsupportedVkCodes: [186],
    });
  });

  it("returns no accelerator when every key is unsupported", () => {
    expect(vkCodesToElectronAccelerator([186, 187])).toEqual({
      accelerator: null,
      unsupportedVkCodes: [186, 187],
    });
  });

  it("ignores duplicate modifiers", () => {
    expect(vkCodesToElectronAccelerator([16, 16, 65]).accelerator).toBe(
      "Shift+A"
    );
  });
});

describe("registerGlobalShortcut", () => {
  beforeAll(() => {
    installLoggerStub();
  });

  beforeEach(() => {
    vi.mocked(globalShortcut.register).mockClear();
    vi.mocked(globalShortcut.unregister).mockClear();
    vi.mocked(globalShortcut.register).mockReturnValue(true);
  });

  it("registers a converted accelerator", () => {
    const callback = vi.fn();

    expect(registerGlobalShortcut("play", ["17", "76"], callback)).toBe(true);
    expect(globalShortcut.register).toHaveBeenCalledWith("Control+L", callback);
  });

  it("replaces a previous accelerator registered under the same name", () => {
    registerGlobalShortcut("replace-me", ["17", "76"], vi.fn());
    registerGlobalShortcut("replace-me", ["17", "77"], vi.fn());

    expect(globalShortcut.unregister).toHaveBeenCalledWith("Control+L");
    expect(globalShortcut.register).toHaveBeenLastCalledWith(
      "Control+M",
      expect.any(Function)
    );
  });

  it("refuses to register when there is no trigger key", () => {
    expect(registerGlobalShortcut("modifiers-only", ["17"], vi.fn())).toBe(
      false
    );
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });

  it("reports the failure when the OS rejects the accelerator", () => {
    vi.mocked(globalShortcut.register).mockReturnValue(false);

    expect(registerGlobalShortcut("rejected", ["17", "76"], vi.fn())).toBe(
      false
    );
  });

  it("warns about unsupported keys but still registers", () => {
    const logger = installLoggerStub();

    expect(
      registerGlobalShortcut("partial", ["17", "186", "76"], vi.fn())
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("unregisterGlobalShortcut", () => {
  beforeAll(() => {
    installLoggerStub();
  });

  it("unregisters a previously registered accelerator", () => {
    vi.mocked(globalShortcut.unregister).mockClear();
    registerGlobalShortcut("to-remove", ["17", "76"], vi.fn());

    unregisterGlobalShortcut("to-remove");

    expect(globalShortcut.unregister).toHaveBeenCalledWith("Control+L");
  });

  it("logs when the name is unknown", () => {
    const logger = installLoggerStub();
    vi.mocked(globalShortcut.unregister).mockClear();

    unregisterGlobalShortcut("never-registered");

    expect(globalShortcut.unregister).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});
