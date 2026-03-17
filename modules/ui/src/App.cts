import { createApp, createWindow, destroyApp } from "./module.cjs";

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
    const menuSkinXml = await options.readSkinPack("/menu/skin.xml");
    const [ptr, timerPtr] = createApp({ ...options, menuSkinXml });
    const app = new App(ptr, timerPtr);
    finalizer.register(app, [ptr, timerPtr]);
    return app;
  }

  createWindow() {
    createWindow(this._ptr);
  }
}
