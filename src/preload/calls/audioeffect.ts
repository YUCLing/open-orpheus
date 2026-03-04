import { registerCallHandler } from "../calls";

registerCallHandler<[number, {
  path: string;
  pathtype: number;
}, boolean], [boolean]>("audioeffect.setParams", () => {
  console.warn("audioeffect.setParams is not implemented yet, but returning void now.");
  return [true];
});

registerCallHandler<[boolean], void>("audioeffect.setLoudnessON", () => {
  console.warn("audioeffect.setLoudnessON is not implemented yet.");
});
