import type { DesktopLyricsPlayInfo, LyricsStyle } from "$sharedTypes/desktop-lyrics";

export interface DesktopLyricsContract {
  platform: NodeJS.Platform;
  events: {
    styleUpdate(callback: (style: LyricsStyle) => void): void;
    lockUpdate(callback: (locked: boolean) => void): void;
    offsetUpdate(callback: (offset: number) => void): void;
    playInfoUpdate(callback: (info: DesktopLyricsPlayInfo | null) => void): void;
    blur(callback: () => void): void;
    /**
     * Ask for the screen size to be reported again.
     *
     * The renderer reports it as soon as it is up, which can be before the
     * window's surface has a native identity for the report to be recorded
     * against — and a window the native layer does not know the size of is one
     * a drag cannot hold on the screen. Once the window is up, the main process
     * asks again.
     */
    requestScreenSize(callback: () => void): void;
  };
  requestFullUpdate(): Promise<void>;
  /**
   * The size of the screen this window is on, in the logical coordinates the
   * window is placed in.
   *
   * A layer surface lives on one output and cannot be moved to another, so the
   * native layer needs to know where that output ends to keep a drag inside it;
   * the renderer is the only half that can read it.
   */
  reportScreenSize(width: number, height: number): Promise<void>;
  dragWindow(): Promise<void>;
  /**
   * Lay the window out the way the lyrics are laid out.
   *
   * The orientation is the renderer's to state, not for the main process to
   * toggle: the window is created at the size it was last left at, so a page
   * that has just mounted is already the right way round, and swapping there
   * would undo the very size it was created with. `vertical` is
   * `LyricsStyle.vertical`, which the renderer has in hand when it notices the
   * setting change.
   */
  changeOrientation(vertical: boolean): Promise<void>;
  performAction(action: string): Promise<void>;
  onMouseWheel(pageX: number, pageY: number, delta: number, modifier?: number): Promise<void>;
}

export interface DesktopLyricsPreviewContract {
  requestInit(): Promise<{ style: LyricsStyle; text: string }>;
  ready(): Promise<void>;
}
