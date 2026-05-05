import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { app } from "electron";

import type { TrayLyricsExtensionInstallResult } from "../bridge/manage-api";

const execFileAsync = promisify(execFile);

const EXTENSION_UUID = "open-orpheus-tray-lyrics@open-orpheus";
const EXTENSION_SOURCE_DIR = path.join(
  "gnome-shell-extension",
  EXTENSION_UUID
);

export async function isTrayLyricsExtensionInstalled(): Promise<boolean> {
  if (os.platform() !== "linux") return false;

  try {
    await run("gnome-extensions", ["info", EXTENSION_UUID]);
    return true;
  } catch {
    return false;
  }
}

export async function installTrayLyricsExtension(): Promise<TrayLyricsExtensionInstallResult> {
  if (os.platform() !== "linux") {
    return result(false, false, false, false, "状态栏歌词扩展仅支持 Linux GNOME。");
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

    await restartExtension();
    const enableResult = await enableExtension();
    return {
      ok: enableResult.enabled,
      enabled: enableResult.enabled,
      installed: true,
      needsRelogin: enableResult.needsRelogin,
      message: enableResult.enabled
        ? "GNOME Shell 扩展已安装并启用。"
        : "扩展已安装，但当前 GNOME Shell 会话尚未识别它。请重新登录一次后再启用。",
    };
  } catch (error) {
    return result(
      false,
      false,
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

async function restartExtension(): Promise<void> {
  await callShellExtensionMethod("DisableExtension").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function enableExtension(): Promise<{
  enabled: boolean;
  needsRelogin: boolean;
}> {
  try {
    const { stdout } = await callShellExtensionMethod("EnableExtension");

    if (stdout.includes("true")) return { enabled: true, needsRelogin: false };
  } catch {
    // Fall back to the CLI below.
  }

  try {
    await run("gnome-extensions", ["enable", EXTENSION_UUID]);
    return { enabled: true, needsRelogin: false };
  } catch {
    return { enabled: false, needsRelogin: true };
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
  ok: boolean,
  enabled: boolean,
  installed: boolean,
  needsRelogin: boolean,
  message: string
): TrayLyricsExtensionInstallResult {
  return { ok, enabled, installed, needsRelogin, message };
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
