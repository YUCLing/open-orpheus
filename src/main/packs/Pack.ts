import unzipper from "unzipper";

export default abstract class Pack {
  protected path: string;
  protected files: Map<string, unzipper.File> = new Map();

  get fileList(): string[] {
    return Array.from(this.files.keys());
  }

  constructor(path: string) {
    this.path = path;
  }

  abstract readPack(verify?: boolean): Promise<void>;
  abstract readFile(path: string): Promise<Buffer>;
}
