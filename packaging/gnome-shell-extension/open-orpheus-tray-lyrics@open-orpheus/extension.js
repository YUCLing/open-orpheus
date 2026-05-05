/* eslint-disable import/no-unresolved */
/* global logError */

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import St from "gi://St";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";

const RUNTIME_DIR_NAME = "open-orpheus";
const STATE_FILE_NAME = "tray-lyrics.json";
const CONTROL_FILE_NAME = "tray-lyrics-control.json";

const TrayLyricsIndicator = GObject.registerClass(
  class TrayLyricsIndicator extends PanelMenu.Button {
    _init() {
      super._init(0.0, "Open Orpheus Tray Lyrics");

      this._readTimeoutId = 0;
      this._monitor = null;
      this._dir = this._getRuntimePath(RUNTIME_DIR_NAME);
      this._statePath = GLib.build_filenamev([this._dir, STATE_FILE_NAME]);
      this._controlPath = GLib.build_filenamev([this._dir, CONTROL_FILE_NAME]);

      GLib.mkdir_with_parents(this._dir, 0o700);

      this._label = new St.Label({
        style_class: "open-orpheus-tray-lyrics-label",
        text: "",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._label.clutter_text.set_single_line_mode(true);
      this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      this.add_child(this._label);

      this.menu.addAction("关闭状态栏歌词", () => {
        this._writeControl({ action: "disable", updatedAt: Date.now() });
        this._setVisibleText("");
      });

      this._setupMonitor();
      this._readState();
    }

    destroy() {
      if (this._readTimeoutId) {
        GLib.Source.remove(this._readTimeoutId);
        this._readTimeoutId = 0;
      }
      if (this._monitor) {
        this._monitor.cancel();
        this._monitor = null;
      }
      super.destroy();
    }

    _setupMonitor() {
      const dir = Gio.File.new_for_path(this._dir);
      this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
      this._monitor.connect("changed", (_monitor, file) => {
        if (file.get_basename() !== STATE_FILE_NAME) return;
        this._queueReadState();
      });
    }

    _queueReadState() {
      if (this._readTimeoutId) return;

      this._readTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
        this._readTimeoutId = 0;
        this._readState();
        return GLib.SOURCE_REMOVE;
      });
    }

    _readState() {
      try {
        const [ok, bytes] = GLib.file_get_contents(this._statePath);
        if (!ok) {
          this._setVisibleText("");
          return;
        }

        const state = JSON.parse(new TextDecoder().decode(bytes));
        this._setVisibleText(state.visible ? state.text || "" : "");
      } catch {
        this._setVisibleText("");
      }
    }

    _setVisibleText(text) {
      this._label.set_text(text);
      this.visible = text.length > 0;
    }

    _writeControl(control) {
      try {
        GLib.mkdir_with_parents(this._dir, 0o700);
        GLib.file_set_contents(
          this._controlPath,
          `${JSON.stringify(control)}\n`
        );
      } catch (error) {
        logError(error, "Failed to write Open Orpheus tray lyrics control");
      }
    }

    _getRuntimePath(name) {
      const runtimeDir = GLib.getenv("XDG_RUNTIME_DIR") || GLib.get_tmp_dir();
      return GLib.build_filenamev([runtimeDir, name]);
    }
  }
);

export default class OpenOrpheusTrayLyricsExtension extends Extension {
  enable() {
    this._indicator = new TrayLyricsIndicator();
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, "right");
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
