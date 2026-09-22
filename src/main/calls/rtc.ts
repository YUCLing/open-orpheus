import { registerCallHandler } from "../calls";

export function register(): void {
  registerCallHandler<[Record<string, unknown>], void>("rtc.enter", () => {
    /* empty */
  });

  registerCallHandler<[], [boolean]>("rtc.leave", () => {
    return [true];
  });
}
