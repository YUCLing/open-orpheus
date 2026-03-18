import { createApp, createWindow, destroyApp, loadSkin } from "./module.cjs";

const finalizer = new FinalizationRegistry((ptrs: [number, number]) => {
  destroyApp(...ptrs);
});

type CreateAppOptions = Omit<Parameters<typeof createApp>[0], "menuSkinXml"> & {
  readSkinPack: (path: string) => Promise<Buffer>;
};

export default class App {
  private _ptr: number;
  private _timerPtr: number;

  private constructor(ptr: number, timerPtr: number) {
    this._ptr = ptr;
    this._timerPtr = timerPtr;
  }

  static async create(options: CreateAppOptions): Promise<App> {
    const [ptr, timerPtr] = createApp({ ...options });
    const app = new App(ptr, timerPtr);
    finalizer.register(app, [ptr, timerPtr]);
    return app;
  }

  loadSkin(path: string) {
    return loadSkin(this._ptr, path);
  }

  createWindow() {
    createWindow(this._ptr);
  }
}
