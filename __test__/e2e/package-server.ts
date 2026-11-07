import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const BUILD_DIR = resolve(import.meta.dirname, "../../.vite/build");

/** Serves a cached NetEase installer over loopback. */
export async function startPackageServer(file: string) {
  const size = statSync(file).size;
  const server = createServer((_request, response) => {
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
    });
    stream.pipe(response);
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("package server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/installer.exe`,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

/**
 * Rewrites the download URL baked into the built bundles.
 *
 * `versions.json` is imported at build time, so the download source cannot be
 * redirected at runtime without touching the app source. The bundles are
 * untracked build output, so rewriting them keeps `src/` untouched while the
 * suite still drives the real HTTP download and 7z-wasm extraction.
 *
 * Returns a function that restores the original bundle contents.
 */
export function redirectBuiltDownloadUrl(from: string, to: string): () => void {
  const restore: Array<() => void> = [];

  for (const relative of readdirSync(BUILD_DIR, { recursive: true, encoding: "utf8" })) {
    if (!/\.[cm]?js$/.test(relative)) continue;
    const file = join(BUILD_DIR, relative);
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      continue; // recursive readdir also yields directory names
    }
    if (!source.includes(from)) continue;
    writeFileSync(file, source.split(from).join(to));
    restore.push(() => writeFileSync(file, source));
  }

  if (restore.length === 0) {
    throw new Error(`no built bundle under ${BUILD_DIR} references ${from}`);
  }

  return () => {
    for (const undo of restore) undo();
  };
}
