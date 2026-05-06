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
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Slider from "resource:///org/gnome/shell/ui/slider.js";

const RUNTIME_DIR_NAME = "open-orpheus";
const STATE_FILE_NAME = "tray-lyrics.json";
const CONTROL_FILE_NAME = "tray-lyrics-control.json";
const DEFAULT_STYLE = {
  fontFamily: "",
  color: "",
};
const MAX_FONT_FAMILY_LENGTH = 80;
const COLOR_PICKER_FALLBACK = "#ffffff";
const PRESET_COLORS = [
  "#ffffff",
  "#df3434",
  "#f59e0b",
  "#22c55e",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
  "#111827",
];

const TrayLyricsIndicator = GObject.registerClass(
  class TrayLyricsIndicator extends PanelMenu.Button {
    _init() {
      super._init(0.0, "Open Orpheus Tray Lyrics");

      this._readTimeoutId = 0;
      this._monitor = null;
      this._dir = this._getRuntimePath(RUNTIME_DIR_NAME);
      this._statePath = GLib.build_filenamev([this._dir, STATE_FILE_NAME]);
      this._controlPath = GLib.build_filenamev([this._dir, CONTROL_FILE_NAME]);
      this._style = { ...DEFAULT_STYLE };
      this._visibleText = "";
      this._systemFonts = this._loadSystemFonts();

      GLib.mkdir_with_parents(this._dir, 0o700);

      this._label = new St.Label({
        style_class: "open-orpheus-tray-lyrics-label",
        text: "",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._label.clutter_text.set_single_line_mode(true);
      this._label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
      this.add_child(this._label);

      this._setupMenu();
      this._applyStyle();
      this._syncStyleEntries();
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

    _setupMenu() {
      const editHeaderItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      editHeaderItem.actor.add_style_class_name(
        "open-orpheus-tray-lyrics-section-item"
      );
      editHeaderItem.add_child(
        new St.Label({
          text: "编辑状态栏歌词",
          style_class: "open-orpheus-tray-lyrics-section-label",
        })
      );
      this.menu.addMenuItem(editHeaderItem);

      this._fontMenuItem = new PopupMenu.PopupSubMenuMenuItem("字体");
      this.menu.addMenuItem(this._fontMenuItem);
      this._setupFontMenu(this._fontMenuItem.menu);

      this._colorMenuItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      this._colorMenuItem.actor.add_style_class_name(
        "open-orpheus-tray-lyrics-color-item"
      );
      this.menu.addMenuItem(this._colorMenuItem);
      this._setupColorMenuItem(this._colorMenuItem);

      this.menu.addAction("保存样式", () => this._saveStyleFromMenu());
      this.menu.addAction("恢复默认样式", () => {
        this._setStyle(DEFAULT_STYLE);
        this._writeControl({ action: "setStyle", style: DEFAULT_STYLE });
      });

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this.menu.addAction("关闭状态栏歌词", () => {
        this._writeControl({ action: "disable" });
        this._setVisibleText("");
      });
    }

    _setupFontMenu(menu) {
      menu.addAction("默认字体", () => {
        this._pendingFontFamily = "";
        this._refreshStyleEditorState();
      });

      for (const font of this._systemFonts) {
        menu.addAction(font, () => {
          this._pendingFontFamily = font;
          this._refreshStyleEditorState();
        });
      }

      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      menu.addAction("使用当前样式", () => {
        this._pendingFontFamily = this._style.fontFamily;
        this._refreshStyleEditorState();
      });
    }

    _setupColorMenuItem(item) {
      const box = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        style_class: "open-orpheus-tray-lyrics-color-box",
      });

      const header = new St.BoxLayout({
        x_expand: true,
        style_class: "open-orpheus-tray-lyrics-menu-row",
      });
      const label = new St.Label({
        text: "显示颜色",
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._colorPreview = new St.Widget({
        style_class: "open-orpheus-tray-lyrics-color-preview",
      });
      header.add_child(label);
      header.add_child(this._colorPreview);
      box.add_child(header);

      const sliderRows = [
        ["R", "r"],
        ["G", "g"],
        ["B", "b"],
      ];
      this._colorSliders = {};

      for (const [labelText, key] of sliderRows) {
        const row = new St.BoxLayout({
          x_expand: true,
          style_class: "open-orpheus-tray-lyrics-menu-row",
        });
        const channelLabel = new St.Label({
          text: labelText,
          width: 18,
          y_align: Clutter.ActorAlign.CENTER,
        });
        const slider = new Slider.Slider(1);
        slider.width = 140;
        slider.connect("notify::value", () => {
          this._syncColorFromSliderState();
        });
        const valueLabel = new St.Label({
          text: "255",
          width: 36,
          y_align: Clutter.ActorAlign.CENTER,
          x_align: Clutter.ActorAlign.END,
        });

        row.add_child(channelLabel);
        row.add_child(slider);
        row.add_child(valueLabel);
        box.add_child(row);

        this._colorSliders[key] = { slider, valueLabel };
      }

      const presetRow = new St.BoxLayout({
        x_expand: true,
        style_class: "open-orpheus-tray-lyrics-color-presets",
      });
      for (const color of PRESET_COLORS) {
        const button = new St.Button({
          style_class: "open-orpheus-tray-lyrics-color-swatch",
          can_focus: true,
        });
        button.set_style(`background-color: ${color};`);
        button.connect("clicked", () => {
          this._pendingColor = color;
          this._syncColorControls();
        });
        presetRow.add_child(button);
      }
      box.add_child(presetRow);

      const actionsRow = new St.BoxLayout({
        x_expand: true,
        style_class: "open-orpheus-tray-lyrics-color-actions",
      });
      const themeButton = new St.Button({
        label: "主题颜色",
        can_focus: true,
        style_class: "open-orpheus-tray-lyrics-text-button",
      });
      themeButton.connect("clicked", () => {
        this._pendingColor = "";
        this._refreshStyleEditorState();
      });
      const currentButton = new St.Button({
        label: "当前颜色",
        can_focus: true,
        style_class: "open-orpheus-tray-lyrics-text-button",
      });
      currentButton.connect("clicked", () => {
        this._pendingColor = this._style.color;
        this._refreshStyleEditorState();
      });
      actionsRow.add_child(themeButton);
      actionsRow.add_child(currentButton);
      box.add_child(actionsRow);

      item.add_child(box);
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
        this._setStyle(state.style);
        this._setVisibleText(state.visible ? state.text || "" : "");
      } catch {
        this._setVisibleText("");
      }
    }

    _setVisibleText(text) {
      this._visibleText = text;
      this._renderVisibleText();
      this.visible = text.length > 0;
    }

    _setStyle(style) {
      const nextStyle = this._normalizeStyle(style);
      if (
        nextStyle.fontFamily === this._style.fontFamily &&
        nextStyle.color === this._style.color
      ) {
        return;
      }

      this._style = nextStyle;
      this._applyStyle();
      this._syncStyleEntries();
    }

    _applyStyle() {
      const style = [];
      if (this._style.fontFamily) {
        style.push(`font-family: ${this._style.fontFamily}`);
      }
      if (this._style.color) {
        style.push(`color: ${this._style.color}`);
      }

      this._label.set_style(style.length ? `${style.join("; ")};` : null);
      this._renderVisibleText();
    }

    _renderVisibleText() {
      if (!this._visibleText || !this._style.color) {
        this._label.set_text(this._visibleText);
        return;
      }

      const escaped = GLib.markup_escape_text(this._visibleText, -1);
      this._label.clutter_text.set_markup(
        `<span foreground="${this._style.color}">${escaped}</span>`
      );
    }

    _syncStyleEntries() {
      this._pendingFontFamily = this._style.fontFamily;
      this._pendingColor = this._style.color;
      this._refreshStyleEditorState();
    }

    _refreshStyleEditorState() {
      if (this._fontMenuItem) {
        this._fontMenuItem.label.text = this._pendingFontFamily
          ? `字体：${this._pendingFontFamily}`
          : "字体：默认字体";
      }

      this._syncColorControls();
    }

    _saveStyleFromMenu() {
      const style = {
        fontFamily: this._normalizeFontFamily(this._pendingFontFamily, ""),
        color: this._normalizeColor(this._pendingColor, this._style.color),
      };

      this._setStyle(style);
      this._syncStyleEntries();
      this._writeControl({ action: "setStyle", style });
    }

    _normalizeStyle(style) {
      const value = style && typeof style === "object" ? style : {};
      return {
        fontFamily: this._normalizeFontFamily(value.fontFamily, ""),
        color: this._normalizeColor(value.color, ""),
      };
    }

    _normalizeFontFamily(value, fallback) {
      if (typeof value !== "string") return fallback;

      return value
        .replace(/[;{}\r\n]/g, "")
        .trim()
        .slice(0, MAX_FONT_FAMILY_LENGTH);
    }

    _normalizeColor(value, fallback) {
      if (typeof value !== "string") return fallback;

      const color = value.trim();
      if (color === "") return "";

      const hexColor = color.startsWith("#") ? color : `#${color}`;
      const shortHex = hexColor.match(/^#([0-9a-fA-F]{3})$/);
      if (shortHex) {
        return `#${shortHex[1]
          .split("")
          .map((part) => part + part)
          .join("")
          .toLowerCase()}`;
      }

      if (/^#[0-9a-fA-F]{6}$/.test(hexColor)) return hexColor.toLowerCase();
      return fallback;
    }

    _syncColorControls() {
      const color = this._normalizeColor(this._pendingColor, "");
      const [r, g, b] = this._hexToRgb(color || COLOR_PICKER_FALLBACK);
      this._setSliderValue("r", r);
      this._setSliderValue("g", g);
      this._setSliderValue("b", b);

      if (this._colorPreview) {
        this._colorPreview.set_style(
          `background-color: ${color || COLOR_PICKER_FALLBACK};`
        );
      }

      if (this._colorMenuItem?.label) {
        this._colorMenuItem.label.text = color
          ? `显示颜色：${color}`
          : "显示颜色：主题颜色";
      }
    }

    _setSliderValue(key, value) {
      const state = this._colorSliders?.[key];
      if (!state) return;

      this._updatingColorControls = true;
      state.slider.value = value / 255;
      state.valueLabel.text = `${value}`;
      this._updatingColorControls = false;
    }

    _syncColorFromSliderState() {
      if (this._updatingColorControls || !this._colorSliders) return;

      const r = Math.round(this._colorSliders.r.slider.value * 255);
      const g = Math.round(this._colorSliders.g.slider.value * 255);
      const b = Math.round(this._colorSliders.b.slider.value * 255);

      this._colorSliders.r.valueLabel.text = `${r}`;
      this._colorSliders.g.valueLabel.text = `${g}`;
      this._colorSliders.b.valueLabel.text = `${b}`;

      this._pendingColor = this._rgbToHex(r, g, b);
      if (this._colorPreview) {
        this._colorPreview.set_style(`background-color: ${this._pendingColor};`);
      }
    }

    _hexToRgb(color) {
      const hex = this._normalizeColor(color, COLOR_PICKER_FALLBACK).slice(1);
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ];
    }

    _rgbToHex(r, g, b) {
      return `#${[r, g, b]
        .map((value) =>
          Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
        )
        .join("")}`;
    }

    _loadSystemFonts() {
      try {
        const [ok, stdout] = GLib.spawn_command_line_sync("fc-list : family");
        if (!ok) return [];

        const fonts = new Set();
        const lines = new TextDecoder().decode(stdout).split("\n");
        for (const line of lines) {
          for (const family of line.split(",")) {
            const font = family.trim();
            if (font) fonts.add(font);
          }
        }

        return [...fonts].sort((a, b) => a.localeCompare(b));
      } catch (error) {
        logError(error, "Failed to load system fonts for tray lyrics");
        return [];
      }
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
