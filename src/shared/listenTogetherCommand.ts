import { isRecord, getStringField, getNumberField } from "./utils";

export const LISTEN_TOGETHER_PLAY_COMMAND_MESSAGE_TYPE = 20000;
export const LISTEN_TOGETHER_SYNC_MESSAGE_TYPE = 20012;

export type ListenTogetherCommandInfo = {
  commandType?: string;
  progress?: number;
  playStatus?: string;
  formerSongId?: string;
  targetSongId?: string;
  songId?: string;
  clientSeq?: number;
  [key: string]: unknown;
};

function firstRecord(...values: unknown[]) {
  return values.find(isRecord) ?? null;
}

function getNestedRecord(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function collectNestedRecords(value: unknown, records: Record<string, unknown>[] = []) {
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      collectNestedRecords(JSON.parse(value), records);
    } catch {
      // Plain string, not nested JSON.
    }
    return records;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedRecords(item, records);
    return records;
  }
  if (!isRecord(value)) return records;
  records.push(value);
  for (const item of Object.values(value)) collectNestedRecords(item, records);
  return records;
}

function hasListenTogetherPlayCommandType(record: Record<string, unknown>) {
  const type = getNumberField(record, ["type", "msgType", "messageType", "bizType"]);
  return type === LISTEN_TOGETHER_PLAY_COMMAND_MESSAGE_TYPE;
}

export function normalizeCommandToken(value: string | undefined) {
  return value?.trim().toUpperCase();
}

export function normalizePlayStatus(value: unknown) {
  if (typeof value === "boolean") return value ? "PLAY" : "PAUSE";
  if (typeof value === "number") {
    if (value === 1) return "PLAY";
    if (value === 0 || value === 2) return "PAUSE";
  }
  if (typeof value !== "string") return undefined;

  const token = value.trim().toUpperCase();
  if (["PLAY", "PLAYING", "START", "STARTED", "RESUME", "RESUMED"].includes(token)) {
    return "PLAY";
  }
  if (["PAUSE", "PAUSED", "STOP", "STOPPED"].includes(token)) {
    return "PAUSE";
  }
  return undefined;
}

export function normalizeCommandType(value: string | undefined) {
  const token = normalizeCommandToken(value);
  if (!token) return undefined;
  if (["PLAY", "PAUSE", "PROGRESS", "GOTO", "SEEK", "SEEKED", "NEXT", "SWITCH", "CHANGE"].includes(token)) {
    if (token === "SEEK" || token === "SEEKED") return "PROGRESS";
    if (token === "SWITCH" || token === "CHANGE") return "NEXT";
    return token;
  }
  return undefined;
}

function extractFromRecord(
  commandInfo: Record<string, unknown>
): ListenTogetherCommandInfo | null {
  if (!commandInfo) return null;

  const typedContent = getNestedRecord(commandInfo, ["content"]);
  if (typedContent && hasListenTogetherPlayCommandType(commandInfo)) {
    const nestedCommandInfo = extractFromRecord(typedContent);
    if (nestedCommandInfo) return nestedCommandInfo;
  }

  const commandType = normalizeCommandType(
    getStringField(commandInfo, ["commandType", "cmd", "type", "action", "eventType"])
  );
  const playStatus = normalizePlayStatus(
    commandInfo.playStatus ?? commandInfo.status ?? commandInfo.playing ?? commandInfo.isPlaying ?? commandInfo.state
  );
  const progress = getNumberField(commandInfo, [
    "progress",
    "position",
    "currentTime",
    "playTime",
    "time",
  ]);
  const targetSongId = getStringField(commandInfo, [
    "targetSongId",
    "songId",
    "musicId",
    "trackId",
    "resourceId",
  ]);
  const formerSongId = getStringField(commandInfo, [
    "formerSongId",
    "fromSongId",
    "prevSongId",
    "lastSongId",
  ]);
  const clientSeq = getNumberField(commandInfo, ["clientSeq", "seq", "sequence", "msgId"]);

  if (!commandType && !playStatus) return null;
  if (!targetSongId && !formerSongId && progress === undefined) return null;

  return {
    commandType,
    playStatus,
    progress,
    targetSongId,
    formerSongId,
    songId: targetSongId,
    clientSeq,
  };
}

export function extractListenTogetherCommandInfo(value: unknown): ListenTogetherCommandInfo | null {
  if (typeof value === "string") {
    try {
      return extractListenTogetherCommandInfo(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const directCommandInfo = firstRecord(
    value.commandInfo,
    getNestedRecord(value, ["data", "commandInfo"]),
    getNestedRecord(value, ["result", "commandInfo"]),
    getNestedRecord(value, ["content", "commandInfo"]),
    getNestedRecord(value, ["payload", "commandInfo"]),
    getNestedRecord(value, ["data", "content"]),
    getNestedRecord(value, ["result", "content"]),
    getNestedRecord(value, ["content", "content"]),
    getNestedRecord(value, ["payload", "content"]),
    value.data,
    value.result,
    value.content,
    value.payload,
    value.status,
    value
  );
  const commandInfo = directCommandInfo
    ? extractFromRecord(directCommandInfo)
    : null;
  if (commandInfo) return commandInfo;

  for (const record of collectNestedRecords(value)) {
    const nestedCommandInfo = extractFromRecord(record);
    if (nestedCommandInfo) return nestedCommandInfo;
  }
  return null;
}

export function getCommandSongId(command: ListenTogetherCommandInfo) {
  const songId = command.targetSongId || command.songId || command.formerSongId;
  return typeof songId === "string" || typeof songId === "number" ? String(songId) : "";
}
