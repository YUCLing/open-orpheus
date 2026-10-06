// Runs inside the sandboxed preload; reports what the isolated world permits.
const { ipcRenderer } = require("electron");

const results = {};

try {
  results.newFunction = new Function("return 1")();
} catch (error) {
  results.newFunctionError = String(error);
}

try {
  results.eval = eval("1");
} catch (error) {
  results.evalError = String(error);
}

// Control: the sandbox is expected to reject Node builtins, unlike `new Function`.
try {
  results.nodeRequire = typeof require("node:fs").readFileSync;
} catch (error) {
  results.nodeRequireError = String(error);
}

ipcRenderer.send("spike:result", results);
