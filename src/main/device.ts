import { existsSync } from "node:fs";
import { join } from "node:path";
import { data as dataDir } from "./folders";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const deviceIdFilePath = join(dataDir, "device_id.json");

let deviceId = "";
let ADDeviceId = "";

export function getDeviceId() {
  return deviceId;
}

export function getADDeviceId() {
  return ADDeviceId;
}

function generateHexString(length = 52) {
  let result = '';
  const characters = '0123456789ABCDEF';
  for (let i = 0; i < length; i++) {
    result += characters[Math.floor(Math.random() * 16)];
  }
  return result;
}

function generateIdString(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    result += chars[randomIndex];
  }
  return result;
}

export async function prepareDeviceId() {
  if (existsSync(deviceIdFilePath)) {
    try {
      const savedDeviceId: {
  deviceId: string;
  ADDeviceId: string;
} = JSON.parse(await readFile(deviceIdFilePath, "utf-8"));
      deviceId = savedDeviceId.deviceId;
      ADDeviceId = savedDeviceId.ADDeviceId;
    } catch (e) {
      console.error("Failed to read device ID from file, generating new ones.", e);
    }
  }
  const randomMACAddress = Array.from({ length: 6 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  ).join(":").toUpperCase();

  deviceId = generateHexString();

  const signStr = `${randomMACAddress}@@@${generateIdString()}`;

  ADDeviceId = `${signStr}@@@@@@${createHash('sha256').update(signStr, 'utf8').digest('hex')}`;

  try {
    await writeFile(deviceIdFilePath, JSON.stringify({ deviceId, ADDeviceId }, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to write device ID to file.", e);
  }
}
