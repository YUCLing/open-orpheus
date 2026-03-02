import { existsSync } from "node:fs";

import { sanitizeRelativePath } from "../util";
import { registerCallHandler } from "../calls";

registerCallHandler<[string], [boolean]>("os.isFileExist", (event, path) => {
  const filePath = sanitizeRelativePath("data", path);
  if (filePath === false) return [false];
  return [existsSync(filePath)];
});
