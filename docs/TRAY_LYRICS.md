# 状态栏歌词

状态栏歌词仅面向 Linux GNOME。Electron `Tray` 在 GNOME 上不是可靠的高频文字显示面：把歌词渲染成图片再反复 `setImage()` 会经过 AppIndicator 图标缓存和刷新队列，实际表现容易明显滞后。

## 方案一：AppIndicator / D-Bus Label

Ayatana AppIndicator、Canonical AppIndicator 体系存在 label 相关能力，例如原生 `app_indicator_set_label` 风格的 API 或相关 D-Bus 属性。

优点：

- 仍然属于 AppIndicator / StatusNotifier 体系。
- 比动态图标轻，不需要截图和图标缓存刷新。

缺点：

- Electron `Tray` 不暴露 Linux label API。
- 需要 native helper 或完整 D-Bus StatusNotifier 实现。
- GNOME AppIndicator 扩展版本不同，label 支持和显示效果可能不一致。

这个方案适合后续需要统一实现 Linux StatusNotifier 后端时再做。

## 方案二：GNOME Shell 扩展

这是当前采用的方案。Open Orpheus 把当前歌词写入运行时文件：

```text
$XDG_RUNTIME_DIR/open-orpheus/tray-lyrics.json
```

GNOME Shell 扩展监听该文件，并直接更新顶部面板里的 `St.Label`。这条链路绕过 AppIndicator 动态图标刷新，因此比动态图标方案更适合作为状态栏文字。

歌词进度不从桌面歌词窗口读取。主播放窗口的 preload 会直接读取当前歌曲的歌词内容，并使用 `HTMLAudioElement.currentTime` 加歌词偏移量匹配当前行。主播放窗口需要禁用 Electron 后台节流，否则窗口隐藏到托盘后 `requestAnimationFrame` 会被延迟，状态栏歌词也会明显滞后。

歌词文本只显示原文：解析优先级为 `yrc -> krc -> lrc`，不会读取 `tlrc` 或 `romalrc`。如果同一时间戳出现多行，会保留第一行；如果单行里带有 `\n`、`/`、`|`、`-` 等常见原文/译文分隔符，只取第一段。

扩展菜单中的关闭操作会写入：

```text
$XDG_RUNTIME_DIR/open-orpheus/tray-lyrics-control.json
```

Open Orpheus 监听这个控制文件，并同步关闭 `trayLyrics.enabled` 设置。

## 安装扩展

推荐在 Open Orpheus 中执行：

```text
管理 Open Orpheus -> 托盘菜单 -> 状态栏歌词 -> 安装并开启
```

Open Orpheus 会自动打包并安装 GNOME Shell 扩展，然后通过 GNOME Shell D-Bus 接口立即启用。大多数情况下不需要重新登录。

如果当前 GNOME Shell 会话尚未识别刚安装的扩展，Open Orpheus 会提示重新登录一次。重新登录后再次点击“安装并开启”即可。

也可以手动在仓库根目录执行：


```bash
gnome-extensions pack -f \
  packaging/gnome-shell-extension/open-orpheus-tray-lyrics@open-orpheus
gnome-extensions install --force \
  open-orpheus-tray-lyrics@open-orpheus.shell-extension.zip
gnome-extensions enable open-orpheus-tray-lyrics@open-orpheus
```

如果 `enable` 提示：

```text
Extension “open-orpheus-tray-lyrics@open-orpheus” does not exist
```

先确认扩展是否已经被 GNOME 识别：

```bash
gnome-extensions list --user | grep open-orpheus-tray-lyrics@open-orpheus
```

如果没有输出，通常是当前 GNOME Shell 会话还没有重新扫描新安装的扩展，或扩展 `metadata.json` 的 `shell-version` 没有包含当前 GNOME 大版本。可用下面的命令查看当前版本：

```bash
gnome-shell --version
```

Wayland 会话下，安装后退出登录再重新登录，然后重新执行 `gnome-extensions enable open-orpheus-tray-lyrics@open-orpheus`。X11 会话通常重启 GNOME Shell 即可。

## 不显示时排查

先确认扩展本身已经启用并处于 active：

```bash
gnome-extensions info open-orpheus-tray-lyrics@open-orpheus
```

如果输出里有 `Enabled: Yes` 和 `State: ACTIVE`，扩展安装侧已经正常。继续看 Open Orpheus 是否写出了可显示歌词：

```bash
cat "$XDG_RUNTIME_DIR/open-orpheus/tray-lyrics.json"
```

典型结果：

- `{"visible":true,...}`：应用已经写出歌词，扩展应该显示。
- `{"visible":false,"text":""...}`：应用当前没有可显示歌词。常见原因是 Open Orpheus 没有运行、当前没有播放歌曲、状态栏歌词开关没有开启、当前歌曲没有原文歌词，或主播放窗口还没有收到歌词内容。

也可以临时写入测试文本来验证 GNOME 扩展显示链路：

```bash
printf '%s\n' '{"visible":true,"text":"Open Orpheus 状态栏歌词测试"}' \
  > "$XDG_RUNTIME_DIR/open-orpheus/tray-lyrics.json"
```

如果测试文本能显示，问题就在 Open Orpheus 应用侧是否运行、是否开启开关、是否正在播放带原文歌词的歌曲。

之后在 Open Orpheus 中开启：

```text
管理 Open Orpheus -> 托盘菜单 -> 状态栏歌词 -> 开启
```
