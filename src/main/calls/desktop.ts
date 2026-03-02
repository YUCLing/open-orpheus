import { registerCallHandler } from "../calls";

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
