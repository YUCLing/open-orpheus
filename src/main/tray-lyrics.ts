import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { app, ipcMain } from "electron";

import {
  addEventListener as addKVEventListener,
  KvChangeEvent,
  kvGet,
  kvSet,
} from "./kv";
import { enableTrayLyricsExtension } from "./gnome-tray-lyrics-extension";
import { mainWindow } from "./window";

const TRAY_LYRICS_ENABLED_KEY = "trayLyrics.enabled";
const TRAY_LYRICS_STYLE_KEY = "trayLyrics.style";

const RUNTIME_DIR_NAME = "open-orpheus";
const STATE_FILE_NAME = "tray-lyrics.json";
const CONTROL_FILE_NAME = "tray-lyrics-control.json";
const DEFAULT_TRAY_LYRICS_STYLE: TrayLyricsStyle = {
  fontFamily: "",
  color: "",
};
const MAX_FONT_FAMILY_LENGTH = 80;

type TrayLyricsStyle = {
  fontFamily: string;
  color: string;
};

type TrayLyricsState = {
  visible: boolean;
  text: string;
  style: TrayLyricsStyle;
};

type TrayLyricsControl =
  | {
      action: "disable";
    }
  | {
      action: "setStyle";
      style?: Partial<TrayLyricsStyle>;
    };

let currentText: string | null = null;
let writtenState: string | null = null;
let controlWatcher: FSWatcher | null = null;
let enabled = readEnabled();
let style = readStyle();

if (enabled) ensureTrayLyricsExtensionEnabled();

addKVEventListener("change", ((event: KvChangeEvent) => {
  const { key, current } = event.detail;
  if (key === TRAY_LYRICS_STYLE_KEY) {
    style = parseStyleValue(current);
    void displayCurrentText();
    return;
  }

  if (key !== TRAY_LYRICS_ENABLED_KEY) return;

  if (current === "true") {
    enableTrayLyrics();
  } else {
    closeTrayLyrics();
  }
}) as EventListener);

ipcMain.on("trayLyrics.updateText", (event, text: string | null) => {
  if (mainWindow && event.sender !== mainWindow.webContents) return;
  updateTrayLyricsText(text);
});

void startControlWatcher();
app.on("before-quit", () => {
  controlWatcher?.close();
  controlWatcher = null;
  void writeTrayLyricsState({
    visible: false,
    text: "",
    style,
  });
});

function isTrayLyricsSupported(): boolean {
  if (os.platform() !== "linux") return false;

  const desktop = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.GDMSESSION,
  ]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

  return desktop.includes("gnome");
}

function closeTrayLyrics(): void {
  enabled = false;
  void displayCurrentText();
}

function enableTrayLyrics(): void {
  enabled = true;
  ensureTrayLyricsExtensionEnabled();
  void displayCurrentText();
}

function setTrayLyricsEnabled(nextEnabled: boolean): void {
  kvSet(TRAY_LYRICS_ENABLED_KEY, nextEnabled ? "true" : "false");
}

function ensureTrayLyricsExtensionEnabled(): void {
  if (!isTrayLyricsSupported()) return;

  void enableTrayLyricsExtension().catch((error) => {
    console.warn("Failed to enable tray lyrics extension:", error);
  });
}

export function getTrayLyricsStyle(): TrayLyricsStyle {
  return { ...style };
}

export function setTrayLyricsStyle(
  nextStyle: Partial<TrayLyricsStyle>
): TrayLyricsStyle {
  const normalized = normalizeStyle({
    ...style,
    ...nextStyle,
  });
  if (stylesEqual(normalized, style)) return normalized;

  style = normalized;
  kvSet(TRAY_LYRICS_STYLE_KEY, JSON.stringify(normalized));
  void displayCurrentText();
  return normalized;
}

function updateTrayLyricsText(text: string | null): void {
  currentText = text;
  void displayCurrentText();
}

async function displayCurrentText(): Promise<void> {
  const state: TrayLyricsState = {
    visible:
      enabled &&
      isTrayLyricsSupported() &&
      currentText !== null &&
      currentText !== "",
    text: currentText ?? "",
    style,
  };

  await writeTrayLyricsState(state);
}

async function writeTrayLyricsState(state: TrayLyricsState): Promise<void> {
  const serialized = JSON.stringify(state);
  if (serialized === writtenState) return;

  writtenState = serialized;
  const dir = await ensureRuntimeDir();
  await writeFile(join(dir, STATE_FILE_NAME), `${serialized}\n`, "utf8");
}

async function startControlWatcher(): Promise<void> {
  if (controlWatcher) return;

  const dir = await ensureRuntimeDir();
  controlWatcher = watch(dir, (eventType, fileName) => {
    if (eventType !== "change" && eventType !== "rename") return;
    if (fileName !== CONTROL_FILE_NAME) return;
    void handleControlFile();
  });
}

async function handleControlFile(): Promise<void> {
  try {
    const raw = await readFile(getControlFilePath(), "utf8");
    const control = JSON.parse(raw) as TrayLyricsControl;
    if (control.action === "disable") {
      setTrayLyricsEnabled(false);
    } else if (control.action === "setStyle") {
      setTrayLyricsStyle(control.style ?? {});
    }
  } catch (error) {
    console.warn("Failed to handle tray lyrics control file:", error);
  }
}

async function ensureRuntimeDir(): Promise<string> {
  const dir = getRuntimeDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function getRuntimeDir(): string {
  return join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), RUNTIME_DIR_NAME);
}

function getControlFilePath(): string {
  return join(getRuntimeDir(), CONTROL_FILE_NAME);
}

function readEnabled(): boolean {
  return kvGet(TRAY_LYRICS_ENABLED_KEY) === "true";
}

function readStyle(): TrayLyricsStyle {
  return parseStyleValue(kvGet(TRAY_LYRICS_STYLE_KEY));
}

function parseStyleValue(value: unknown): TrayLyricsStyle {
  if (value === null) return { ...DEFAULT_TRAY_LYRICS_STYLE };

  try {
    const raw =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value).toString("utf8")
          : "";
    return normalizeStyle(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TRAY_LYRICS_STYLE };
  }
}

function normalizeStyle(value: unknown): TrayLyricsStyle {
  const maybeStyle =
    value && typeof value === "object"
      ? (value as Partial<TrayLyricsStyle>)
      : {};

  return {
    fontFamily: normalizeFontFamily(maybeStyle.fontFamily),
    color: normalizeColor(maybeStyle.color),
  };
}

function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TRAY_LYRICS_STYLE.fontFamily;

  return value
    .replace(/[;{}\r\n]/g, "")
    .trim()
    .slice(0, MAX_FONT_FAMILY_LENGTH);
}

function normalizeColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TRAY_LYRICS_STYLE.color;

  const color = value.trim();
  if (color === "") return "";

  const hexColor = color.startsWith("#") ? color : `#${color}`;
  const shortHex = hexColor.match(/^#([0-9a-fA-F]{3})$/);
  if (shortHex) {
    return `#${shortHex[1]
      .split("")
      .map((part) => part + part)
      .join("")
      .toLowerCase()}`;
  }

  if (/^#[0-9a-fA-F]{6}$/.test(hexColor)) return hexColor.toLowerCase();
  return DEFAULT_TRAY_LYRICS_STYLE.color;
}

function stylesEqual(a: TrayLyricsStyle, b: TrayLyricsStyle): boolean {
  return a.fontFamily === b.fontFamily && a.color === b.color;
}
