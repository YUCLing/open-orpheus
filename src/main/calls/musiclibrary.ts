import { musicLibraryDb } from "../database";
import { registerCallHandler } from "../calls";

registerCallHandler<[string, string[]], [boolean]>(
  "musiclibrary.execSql",
  async (event, taskId, sql) => {
    try {
      const result = musicLibraryDb.executeSqls(sql);
      event.sender.send("channel.call", "musiclibrary.onexecsql", {
        error: 0,
        id: taskId,
        reason: "",
        result: true,
        ...result,
      });
    } catch (error) {
      event.sender.send("channel.call", "musiclibrary.onexecsql", {
        error: 1,
        id: taskId,
        reason: "",
        result: false,
      });
    }
    return [true];
  }
);

// TODO: Observe music library changes
registerCallHandler<[string], void>("musiclibrary.observeLibrary", () => { return });

// TODO: Library adding handling
registerCallHandler<[string, number], [boolean]>("musiclibrary.addLibrary", (event, library) => {
  event.sender.send("channel.call", "musiclibrary.onaddend", {
    dirs: [""],
    library,
    reason: "",
    result: 0,
  });
  return [true];
});
