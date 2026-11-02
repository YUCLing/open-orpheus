import { registerCallHandler } from "../calls";

// TODO: Link mediaSession
registerCallHandler<[boolean], void>("player.setSMTCEnable", (enabled) => {
  LOGGER.warn({ enabled }, "SMTC integration is not implemented");
  return;
});

registerCallHandler<[number], [boolean]>("player.setTotalTime", () => {
  return [true];
});
