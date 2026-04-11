declare module "electron-installer-debian" {
  export class Installer {
    constructor(options: Record<string, unknown>);
    options: {
      name?: unknown;
      version?: unknown;
      depends?: unknown;
    };
    stagingDir: string;
    generateDefaults(): Promise<void>;
    generateOptions(): void;
    createStagingDir(): Promise<void>;
    copyLinuxIcons?(): Promise<void>;
    createBinarySymlink?(): Promise<void>;
    createCopyright?(): Promise<void>;
    createDesktopFile?(): Promise<void>;
    createOverrides?(): Promise<void>;
  }
}
