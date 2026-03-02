import { mkdir, readFile, writeFile } from "node:fs/promises";

import { registerCallHandler } from "../calls";
import { sanitizeRelativePath } from "../util";
import { webDb, storageExecsql as execsql } from "../database";
import { dirname } from "node:path";

// TODO: Better data dir handling
const dataDir = "data";

registerCallHandler<[string, string, boolean, string], void>(
  "storage.readfromfile",
  async (event, taskId, path) => {
    const filePath = sanitizeRelativePath(dataDir, path);
    if (filePath === false) {
      throw new Error(`Forbidden file path access attempt: ${path}`);
    }
    try {
      const fileContent = await readFile(filePath);
      event.sender.send(
        "channel.call",
        "storage.onreadfromfiledone",
        taskId,
        0,
        fileContent.toString("utf-8")
      );
    } catch (error) {
      // -2: Not Found
      event.sender.send(
        "channel.call",
        "storage.onreadfromfiledone",
        taskId,
        -2
      );
    }
  }
);

registerCallHandler<[string, string], void>(
  "storage.execsql",
  async (event, taskId, sql) => {
    const execResult = execsql(webDb, taskId, sql);
    event.sender.send(
      "channel.call",
      "storage.onexecsqldone",
      taskId,
      execResult.errCode,
      execResult.rows,
      execResult.perf
    );
  }
);

registerCallHandler<[string, string, string, string, boolean, string], void>(
  "storage.savetofile",
  async (event, taskId, content, _, path, overwrite) => {
    const filePath = sanitizeRelativePath(dataDir, path);
    if (filePath === false) {
      throw new Error(`Forbidden file path access attempt: ${path}`);
    }

    await mkdir(dirname(filePath), { recursive: true });

    try {
      await writeFile(filePath, content, { flag: overwrite ? "w" : "a" });
      event.sender.send("channel.call", "storage.onsavetofiledone", taskId, 0);
    } catch (error) {
      event.sender.send(
        "channel.call",
        "storage.onsavetofiledone",
        taskId,
        -1,
        error.message
      );
    }
  }
);
