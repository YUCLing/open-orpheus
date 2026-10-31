# MPRIS 播放方式修复验收

验证日期：2026-10-31，Linux / Wayland；源码基线 `e05f1d0`，原生接口修复
`1a27252`，页面和主进程接入 `72f181b`。应用版本号仍为 `0.19.2`。

## 原因与原版本复现

本机原安装包为 `open-orpheus-bin 0.19.2-2`，运行入口位于
`/usr/lib/open-orpheus/open-orpheus`。实际运行的 DMS 使用 `dms-custom/quickshell`。

`busctl --user introspect` 显示 `LoopStatus` 和 `Shuffle` 没有 `writable` 标记。
分别写入 `Shuffle=true` 和 `LoopStatus=Track` 均返回 `Unknown property`。
Rust getter 分别固定返回 `false` 和 `Playlist`，没有 setter；主进程和页面
也没有播放方式的命令或状态连接。

DMS 使用 `shuffleSupported` / `loopSupported` 显示控制按钮，然后直接写入
Quickshell 的 `MprisPlayer.shuffle` / `loopState`。原版本在 DMS 中报告支持这
两个属性，DMS 的本地值会暂时改变，但 D-Bus 和页面均不改变。因此需要补齐
播放器的可写接口和实际页面控制链路。

## 自动验证

- `pnpm test`：70 个文件，779 项通过，1 项跳过。
- `pnpm --dir modules/dbus test`：28 项通过，使用真实会话总线。
- `pnpm exec tsc --noEmit`：通过。
- 相关 TypeScript 文件 `oxlint`、`oxfmt --check` 与 `git diff --check`：通过。
- Rust 原生模块及音效 WASM release 构建、`pnpm package --platform linux --arch x64`：通过。

新增覆盖包括原生属性读写、无效输入、异步失败、状态通知、页面确认超时、
并发请求串行化、应用内变更回报、独立 main-world 函数执行和发现计时器清理。

## 本机运行验证

使用此次构建的 Electron 45.0.0 应用和本机 Orpheus `3.1.41.205529` /
`c6406e5` 资源包验证。逐步对照页面 store、页面按钮的实际模式标题、D-Bus
属性和运行中 DMS 的 `MprisPlayer` 状态。

在现有 DMS 进程中临时添加 IPC 探针，执行与其随机、重复按钮相同的属性写入；
未使用鼠标物理点击 DMS 控件。反向同步通过 CDP 调用页面实际模式按钮的
`click()` 验证，未用虚拟页面或模拟 store 替代运行应用。

| 场景 | 页面结果 | Shuffle / LoopStatus |
| --- | --- | --- |
| 顺序播放初始状态 | 顺序播放 | false / None |
| DMS 开启随机 | 随机播放 | true / Playlist |
| DMS 关闭随机 | 列表循环 | false / Playlist |
| DMS 重复：列表 → 单曲 | 单曲循环 | false / Track |
| DMS 重复：单曲 → 关闭 | 顺序播放 | false / None |
| DMS 重复：关闭 → 列表 | 列表循环 | false / Playlist |
| DMS 从列表开启随机 | 随机播放 | true / Playlist |
| DMS 随机时切到单曲 | 单曲循环 | false / Track |
| 应用内模式按钮切换 | 随机播放，DMS 同步更新 | true / Playlist |
| 直接写 D-Bus 关闭重复 | 顺序播放 | false / None |
| 直接写 D-Bus 恢复原随机模式 | 随机播放 | true / Playlist |

全部 11 个场景通过。此验收验证控制和状态同步，没有等待完整歌曲结束来统计
下一曲的随机分布或循环次数。

## 本机交付与恢复

已验证的应用部署于 `$HOME/.local/opt/open-orpheus-mpris`，命令入口为
`$HOME/.local/bin/open-orpheus`，用户桌面启动器指向该入口并保留原有
`--force-device-scale-factor=1.3`。系统安装包保持可用，不需要 root 权限。

打包及部署的 `resources/app.asar` SHA-256 一致：

```text
56861ddcde3f80bb5f595598bbae941a489e5244c190a23811e54bee571387d4
```

原启动器、DMS 源码文件、DMS 设置和播放器数据快照，以及运行记录保存在
`$HOME/.local/state/open-orpheus-mpris/20261031T210327`。
`mode-acceptance.json` 记录上述 11 组观测值。

验收后已恢复 DMS 文件，确认 DMS 仓库无修改、设置文件字节不变；播放器以
普通入口重新启动，不带远程调试参数，并恢复随机播放模式。

如需回到系统版本，退出播放器，将备份的 `open-orpheus.desktop` 复制回
`$HOME/.local/share/applications/open-orpheus.desktop`，将
`$HOME/.local/bin/open-orpheus` 移至备份目录，然后运行 `/usr/bin/open-orpheus`。
