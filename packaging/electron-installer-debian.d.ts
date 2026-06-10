declare module "electron-installer-debian" {
  import { ElectronInstaller } from "electron-installer-common";

  export class Installer extends ElectronInstaller {
    get contentFunctions(): string[];
    get defaultDesktopTemplatePath(): string;
    get packagePattern(): string;

    constructor(options: object);

    copyApplication(): Promise<unknown>;
    copyScripts(): Promise<unknown>;
    createBinarySymlink(): Promise<void>;
    createControl(): Promise<unknown>;
    createCopyright(): Promise<void>;
    createDesktopFile(): Promise<void>;
    createOverrides(): Promise<unknown>;
    createPackage(): Promise<unknown>;

    generateDefaults(): Promise<unknown>;
    generateOptions(): object;
    getMaintainer(author: unknown): string | undefined;
    normalizeDescription(description: string): string;
    normalizeExtendedDescription(extendedDescription: string): string;
    sanitizeName(name: string): string;

    [key: string]: unknown;
  }

  function installer(data: object): Promise<object>;
  namespace installer {
    export { Installer };
  }

  export = installer;
}
