import { musicLibraryExecsql as execsql, musicLibraryDb } from "../database";
import { registerCallHandler } from "../calls";

registerCallHandler<[string, string[]], [boolean]>(
  "musiclibrary.execSql",
  async (event, taskId, sql) => {
    const ack = execsql(musicLibraryDb, taskId, sql, (results) => {
      event.sender.send("channel.call", "musiclibrary.onexecsql", results);
    });
    return [ack];
  }
);
