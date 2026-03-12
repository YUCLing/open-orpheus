import { createMenu, showMenu } from "./load.cjs";

export default class Menu {
  private ptr: number;

  constructor() {
    this.ptr = createMenu();
  }

  show(): void {
    showMenu(this.ptr);
  }
}
