import { posix } from "node:path";

import unzipper from "unzipper";

export default abstract class Pack {
  protected path: string;
  protected files: Record<string, unzipper.File> = Object.create(null);

  protected _isLoaded = false;

  get fileList(): string[] {
    return Object.keys(this.files);
  }

  get isLoaded(): boolean {
    return this._isLoaded;
  }

  constructor(path: string) {
    this.path = path;
    LOGGER.debug({ pack: this.constructor.name, path }, "Pack instance created");
  }

  protected normalizePath(path: string): string {
    // ZIP entry names always use `/`, regardless of the host platform. Using
    // the host `path` module here would key the archive by `\` on Windows and
    // make every lookup miss.
    return posix.normalize(path.startsWith("/") ? path : `/${path}`);
  }

  abstract readPack(verify?: boolean): Promise<void>;
  abstract readFile(path: string): Promise<Buffer>;
}
