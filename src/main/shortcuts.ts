import { globalShortcut } from "electron";

import parentLogger from "./logger";

const logger = parentLogger.child({ name: "shortcuts" });

export interface VkToElectronResult {
  accelerator: string | null;
  unsupportedVkCodes: number[];
}

const MODIFIER_MAP: Readonly<Record<number, string>> = {
  16: "Shift",
  17: "Control",
  18: "Alt",
  91: "Super",
  92: "Super",
  93: "Super",
};

const NAMED_KEY_MAP: Readonly<Record<number, string>> = {
  8: "Backspace",
  9: "Tab",
  13: "Enter",
  27: "Escape",
  32: "Space",
  33: "PageUp",
  34: "PageDown",
  35: "End",
  36: "Home",
  37: "Left",
  38: "Up",
  39: "Right",
  40: "Down",
  45: "Insert",
  46: "Delete",
  176: "MediaNextTrack",
  177: "MediaPreviousTrack",
  178: "MediaStop",
  179: "MediaPlayPause",
};

const MODIFIER_ORDER = ["Control", "Alt", "Shift", "Super"] as const;

function mapVkToElectronKey(vkCode: number): string | null {
  if (NAMED_KEY_MAP[vkCode]) {
    return NAMED_KEY_MAP[vkCode];
  }

  if (vkCode >= 65 && vkCode <= 90) {
    return String.fromCharCode(vkCode);
  }

  if (vkCode >= 48 && vkCode <= 57) {
    return String.fromCharCode(vkCode);
  }

  if (vkCode >= 96 && vkCode <= 105) {
    return `num${vkCode - 96}`;
  }

  if (vkCode >= 112 && vkCode <= 135) {
    return `F${vkCode - 111}`;
  }

  return null;
}

/**
 * Convert legacy VK/keyCode values (e.g. 17,18,76) into an Electron accelerator.
 */
export function vkCodesToElectronAccelerator(
  vkCodes: readonly number[]
): VkToElectronResult {
  const unsupportedVkCodes: number[] = [];
  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const vkCode of vkCodes) {
    const modifier = MODIFIER_MAP[vkCode];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }

    const mapped = mapVkToElectronKey(vkCode);
    if (!mapped) {
      unsupportedVkCodes.push(vkCode);
      continue;
    }

    // Keep the last non-modifier key as the trigger key.
    key = mapped;
  }

  if (!key) {
    return {
      accelerator: null,
      unsupportedVkCodes,
    };
  }

  const orderedModifiers = MODIFIER_ORDER.filter((token) =>
    modifiers.has(token)
  );

  return {
    accelerator: [...orderedModifiers, key].join("+"),
    unsupportedVkCodes,
  };
}

const registeredShortcuts = new Map<string, string>();

export function registerGlobalShortcut(
  name: string,
  keys: string[],
  callback: () => void
): boolean {
  if (registeredShortcuts.has(name)) {
    unregisterGlobalShortcut(name);
  }
  const result = vkCodesToElectronAccelerator(keys.map(Number));
  if (!result.accelerator) {
    logger.error(
      { keys, unsupportedVkCodes: result.unsupportedVkCodes },
      "Failed to register hotkey %s, no valid trigger key found",
      name
    );
    return false;
  }
  if (result.unsupportedVkCodes.length > 0) {
    logger.warn(
      { keys, unsupportedVkCodes: result.unsupportedVkCodes },
      "Unsupported VK codes found when registering %s",
      name
    );
  }
  const success = globalShortcut.register(result.accelerator, callback);
  if (success) {
    registeredShortcuts.set(name, result.accelerator);
  }
  return success;
}

export function unregisterGlobalShortcut(name: string): void {
  const accelerator = registeredShortcuts.get(name);
  if (!accelerator) {
    logger.error("Failed to unregister hotkey %s", name);
    return;
  }
  globalShortcut.unregister(accelerator);
  registeredShortcuts.delete(name);
}
