import os from "node:os";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import test from "ava";

import { Av3AM4ADecoder } from "../index";

test("exports the decoder class", (t) => {
  t.is(typeof Av3AM4ADecoder, "function");
});

test("rejects a file that is not an M4A/AV3A container", (t) => {
  const invalid = resolve(os.tmpdir(), "open-orpheus-av3a-invalid.m4a");
  writeFileSync(invalid, Buffer.from("this is not an mp4 file at all"));
  try {
    t.throws(() => new Av3AM4ADecoder(invalid));
  } finally {
    rmSync(invalid, { force: true });
  }
});
