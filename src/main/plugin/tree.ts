import { readFile, stat } from "node:fs/promises";

import { sanitizeRelativePath } from "../util/path";

/**
 * A plugin tree is a directory on disk or an `.asar` archive.
 *
 * Electron's `fs` and ESM loader treat an asar as a virtual directory, so both
 * are read in place: there is no extraction, cache, or materialization step.
 */
export interface PluginTree {
  /** The original source (directory or asar path). */
  readonly source: string;
  has(relativePath: string): Promise<boolean>;
  readFile(relativePath: string): Promise<Buffer>;
}

export async function openPluginTree(source: string): Promise<PluginTree> {
  const info = await stat(source);
  const isAsar = info.isFile() && source.toLowerCase().endsWith(".asar");
  if (info.isDirectory() || isAsar) return new FsTree(source);
  throw new Error(`Unsupported plugin source: ${source}`);
}

class FsTree implements PluginTree {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  async has(relativePath: string): Promise<boolean> {
    try {
      const info = await stat(this.resolve(relativePath));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async readFile(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  private resolve(relativePath: string): string {
    const resolved = sanitizeRelativePath(this.source, relativePath);
    if (resolved === false) {
      throw new Error(`Unsafe plugin path: ${relativePath}`);
    }
    return resolved;
  }
}
