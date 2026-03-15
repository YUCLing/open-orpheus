import { createApp, createWindow, destroyApp } from "./module.cjs";

const finalizer = new FinalizationRegistry((ptrs: [number, number]) => {
  destroyApp(...ptrs);
});

export default class App {
  private _ptr: number;
  private _timerPtr: number;

  constructor() {
    [this._ptr, this._timerPtr] = createApp();
    finalizer.register(this, [this._ptr, this._timerPtr]);
  }

  createWindow() {
    createWindow(this._ptr);
  }
}
