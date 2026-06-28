import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import { data as dataDir } from "./folders";
import { isFileNotFound } from "./util";

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
  const byteLength = Math.ceil(length / 2);
  return randomBytes(byteLength).toString("hex").slice(0, length).toUpperCase();
}

function toLegacyEncodedToken(value: string) {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function buildLegacyHardwareToken(seed: string) {
  const digest = createHash("sha256")
    .update(seed, "utf8")
    .digest("hex")
    .toUpperCase();
  const raw = digest.slice(0, 32);
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) {
    groups.push(raw.slice(i, i + 4));
  }
  return groups.join("_");
}

export async function prepareDeviceId() {
  try {
    const savedDeviceId: {
      deviceId: string;
      ADDeviceId: string;
    } = JSON.parse(await readFile(deviceIdFilePath, "utf-8"));
    deviceId = savedDeviceId.deviceId;
    ADDeviceId = savedDeviceId.ADDeviceId;
    if (deviceId && ADDeviceId) {
      return;
    }
  } catch (e) {
    if (!isFileNotFound(e))
      console.error(
        "Failed to read device ID from file, generating new ones.",
        e
      );
  }
  // Generate a legal host MAC address: unicast and universally administered.
  const macBytes = randomBytes(6);
  macBytes[0] = macBytes[0] & 0xfc;
  const randomMACAddress = Array.from(macBytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();

  deviceId = generateHexString();

  const legacyToken = buildLegacyHardwareToken(
    `${deviceId}:${randomMACAddress}`
  );
  const encodedToken = toLegacyEncodedToken(legacyToken);
  const signStr = `${randomMACAddress}@@@${encodedToken}`;

  ADDeviceId = `${signStr}@@@@@@${createHash("sha256").update(signStr, "utf8").digest("hex")}`;

  try {
    await writeFile(
      deviceIdFilePath,
      JSON.stringify({ deviceId, ADDeviceId }, null, 2),
      "utf-8"
    );
  } catch (e) {
    console.error("Failed to write device ID to file.", e);
  }
}
