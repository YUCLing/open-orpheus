import { channel } from "../util";

import "./app";
import "./os";
import "./network";
import "./update";
import "./im";
import "./nimsys";

if (channel === "main") {
  // Only main window uses player
  void Promise.all([import("./audioplayer"), import("./audioeffect"), import("./player")]).then(
    () => {
      LOGGER.debug("Audio call handlers loaded");
    }
  );
}
