import { registerCallHandler } from "./dispatcher";

export function register(): void {
  // 乐评桌面支持
  registerCallHandler<
    [],
    [
      {
        offscreen: boolean;
        support: boolean;
      },
    ]
  >("desktop.support", () => [{ offscreen: false, support: false }]);
}
