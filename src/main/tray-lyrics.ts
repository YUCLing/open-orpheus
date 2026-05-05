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
import { mainWindow } from "./window";

const TRAY_LYRICS_ENABLED_KEY = "trayLyrics.enabled";

const RUNTIME_DIR_NAME = "open-orpheus";
const STATE_FILE_NAME = "tray-lyrics.json";
const CONTROL_FILE_NAME = "tray-lyrics-control.json";

type TrayLyricsState = {
  visible: boolean;
  text: string;
};

type TrayLyricsControl = {
  action: "disable";
};

let currentText: string | null = null;
let writtenState: string | null = null;
let controlWatcher: FSWatcher | null = null;
let enabled = readEnabled();

addKVEventListener("change", ((event: KvChangeEvent) => {
  const { key, current } = event.detail;
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
  void displayCurrentText();
}

function setTrayLyricsEnabled(nextEnabled: boolean): void {
  kvSet(TRAY_LYRICS_ENABLED_KEY, nextEnabled ? "true" : "false");
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
