import { registerCallHandler } from "../calls";

// TODO: Implement this properly, it blocks the app from loading
registerCallHandler<[string, string, string], void>("storage.init", () => {
  return;
});
