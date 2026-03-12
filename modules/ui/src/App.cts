import { createApp, createWindow } from "./load.cjs";

export default class App {
  private _ptr: number;

  constructor() {
    this._ptr = createApp();
  }

  createWindow() {
    createWindow(this._ptr);
  }
}
