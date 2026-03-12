import App from "./App.cjs";
import { createMenu, showMenu } from "./load.cjs";

export default class Menu {
  private _ptr: number;

  constructor(app: App, menuData: any) {
    this._ptr = createMenu((app as unknown as { _ptr: number })._ptr, menuData);
  }

  show(): void {
    showMenu(this._ptr);
  }
}
