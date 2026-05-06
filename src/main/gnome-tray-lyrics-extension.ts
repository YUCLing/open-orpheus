import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { app } from "electron";

import type {
  TrayLyricsExtensionInfo,
  TrayLyricsExtensionInstallResult,
} from "../bridge/manage-api";

const execFileAsync = promisify(execFile);

const EXTENSION_UUID = "open-orpheus-tray-lyrics@open-orpheus";
const EXTENSION_VERSION = 3;
const EXTENSION_SOURCE_DIR = path.join(
  "gnome-shell-extension",
  EXTENSION_UUID
);

export async function isTrayLyricsExtensionInstalled(): Promise<boolean> {
  if (os.platform() !== "linux") return false;

  return await isExtensionInstalledOnDisk();
}

export async function getTrayLyricsExtensionInfo(): Promise<TrayLyricsExtensionInfo> {
  if (os.platform() !== "linux") return extensionInfo(false);

  const installed = await isExtensionInstalledOnDisk();
  const diskVersion = await readInstalledExtensionVersion().catch(() => null);

  try {
    const { stdout } = await run("gnome-extensions", ["info", EXTENSION_UUID]);
    const version = diskVersion ?? parseInfoNumber(stdout, "Version");
    return extensionInfo(installed, {
      recognized: true,
      enabled: parseInfoBoolean(stdout, "Enabled"),
      version,
      upToDate: version !== null && version >= EXTENSION_VERSION,
    });
  } catch {
    return extensionInfo(installed, {
      version: diskVersion,
      upToDate: diskVersion !== null && diskVersion >= EXTENSION_VERSION,
      needsSessionRestart: installed,
    });
  }
}

export async function enableTrayLyricsExtension(): Promise<boolean> {
  if (os.platform() !== "linux") return false;

  const info = await getTrayLyricsExtensionInfo();
  if (!info.installed || !info.recognized) return false;
  if (info.enabled) return true;

  return await enableExtension();
}

export async function installTrayLyricsExtension(): Promise<TrayLyricsExtensionInstallResult> {
  if (os.platform() !== "linux") {
    return result(false, false, "状态栏歌词扩展仅支持 Linux GNOME。");
  }

  const currentInfo = await getTrayLyricsExtensionInfo();
  if (currentInfo.installed && currentInfo.upToDate) {
    if (!currentInfo.recognized) {
      return result(
        false,
        true,
        "扩展文件已安装，但当前 GNOME Shell 会话尚未识别它。请退出登录后重新登录，再启用状态栏歌词。"
      );
    }

    const enabled = currentInfo.enabled || (await enableExtension());
    return result(
      enabled,
      true,
      enabled
        ? "GNOME Shell 扩展已启用。"
        : "扩展已安装，但 GNOME Shell 未能启用它。请在 GNOME 扩展管理中手动启用。"
    );
  }

  const sourceDir = getExtensionSourceDir();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "open-orpheus-gnome-ext-"));

  try {
    await run("gnome-extensions", ["pack", "-f", "-o", outDir, sourceDir]);

    const bundlePath = path.join(
      outDir,
      `${EXTENSION_UUID}.shell-extension.zip`
    );
    await run("gnome-extensions", ["install", "--force", bundlePath]);

    const enabled = await enableExtension();
    return {
      enabled,
      installed: true,
      message: enabled
        ? "GNOME Shell 扩展已安装并启用。"
        : "扩展文件已安装，但当前 GNOME Shell 会话尚未识别它。请退出登录后重新登录，再启用状态栏歌词。",
    };
  } catch (error) {
    return result(
      false,
      false,
      `安装 GNOME Shell 扩展失败：${formatError(error)}`
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function getExtensionSourceDir(): string {
  if (!app.isPackaged) {
    return path.resolve("packaging", EXTENSION_SOURCE_DIR);
  }

  return path.join(process.resourcesPath, EXTENSION_SOURCE_DIR);
}

function getInstalledExtensionDir(): string {
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "gnome-shell",
    "extensions",
    EXTENSION_UUID
  );
}

async function isExtensionInstalledOnDisk(): Promise<boolean> {
  try {
    await access(path.join(getInstalledExtensionDir(), "metadata.json"));
    return true;
  } catch {
    return false;
  }
}

async function readInstalledExtensionVersion(): Promise<number | null> {
  const metadataPath = path.join(getInstalledExtensionDir(), "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    version?: unknown;
  };
  return typeof metadata.version === "number" ? metadata.version : null;
}

async function restartExtension(): Promise<void> {
  await callShellExtensionMethod("DisableExtension").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function enableExtension(): Promise<boolean> {
  try {
    const { stdout } = await callShellExtensionMethod("EnableExtension");

    if (stdout.includes("true")) return true;
  } catch {
    await restartExtension();
  }

  try {
    await run("gnome-extensions", ["enable", EXTENSION_UUID]);
    return true;
  } catch {
    return false;
  }
}

async function callShellExtensionMethod(method: string) {
  return await run("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.gnome.Shell",
    "--object-path",
    "/org/gnome/Shell",
    "--method",
    `org.gnome.Shell.Extensions.${method}`,
    EXTENSION_UUID,
  ]);
}

async function run(command: string, args: string[]) {
  return await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function result(
  enabled: boolean,
  installed: boolean,
  message: string
): TrayLyricsExtensionInstallResult {
  return { enabled, installed, message };
}

function extensionInfo(
  installed: boolean,
  info: Partial<Omit<TrayLyricsExtensionInfo, "installed">> = {}
): TrayLyricsExtensionInfo {
  return {
    installed,
    recognized: info.recognized ?? false,
    enabled: info.enabled ?? false,
    version: info.version ?? null,
    upToDate: info.upToDate ?? false,
    needsSessionRestart: info.needsSessionRestart ?? false,
  };
}

function parseInfoNumber(stdout: string, label: string): number | null {
  const match = stdout.match(new RegExp(`^\\s*${label}:\\s*(\\d+)`, "m"));
  return match ? Number(match[1]) : null;
}

function parseInfoBoolean(stdout: string, label: string): boolean {
  const match = stdout.match(new RegExp(`^\\s*${label}:\\s*(\\S+)`, "m"));
  return match?.[1].toLowerCase() === "yes";
}

function formatError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);

  const maybeError = error as {
    message?: string;
    stderr?: string;
    stdout?: string;
  };
  return (
    maybeError.stderr?.trim() ||
    maybeError.stdout?.trim() ||
    maybeError.message ||
    String(error)
  );
}
