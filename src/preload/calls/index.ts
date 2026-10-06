import { isMain } from "../util";

import "./app";
import "./os";
import "./network";
import "./update";
import "./im";
import "./nimsys";

if (isMain) {
  // Only main window uses player
  void import("./audioplayer");
  void import("./audioeffect");
  void import("./player");
}
