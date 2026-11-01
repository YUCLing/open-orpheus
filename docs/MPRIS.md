# MPRIS 播放方式

[English Version](MPRIS_en.md)

普通安装的服务名称为 `org.mpris.MediaPlayer2.open-orpheus`，对象路径为
`/org/mpris/MediaPlayer2`，播放器接口为 `org.mpris.MediaPlayer2.Player`。
Flatpak 使用 `org.mpris.MediaPlayer2.<FLATPAK_ID>` 作为服务名称。

`Shuffle` 和 `LoopStatus` 均可读写，并通过 `PropertiesChanged` 回报实际状态。
DMS 等客户端写入后，应用等待页面确认对应模式，再完成 D-Bus 调用；页面未就绪、
三秒内未确认或属性值非法时返回错误。应用内切换模式也会同步到 MPRIS。

| 页面播放方式 | `Shuffle` | `LoopStatus` |
| ------------ | --------- | ------------ |
| 顺序播放     | `false`   | `None`       |
| 列表循环     | `false`   | `Playlist`   |
| 单曲循环     | `false`   | `Track`      |
| 随机播放     | `true`    | `Playlist`   |

页面只有一个互斥模式：开启随机播放会退出单曲循环；关闭随机播放会回到列表循环；
设置 `Track` 或 `None` 会退出随机播放；在随机播放时设置 `Playlist` 会保留随机。
心动模式和私人漫游没有完全对应的 MPRIS 模式，读取时报告 `false` / `None`。

```sh
busctl --user introspect org.mpris.MediaPlayer2.open-orpheus \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player

# 开启随机播放
busctl --user set-property org.mpris.MediaPlayer2.open-orpheus \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player Shuffle b true

# 切换到单曲循环
busctl --user set-property org.mpris.MediaPlayer2.open-orpheus \
  /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player LoopStatus s Track
```

页面桥接从已挂载的 React Fiber 树查找播放 store，订阅状态变化并调用页面自身的
`playing/switchPlayingMode`。桥接在各平台的 Orpheus 主页面安装，Linux 通过
MPRIS 适配器连接系统媒体控制。启动发现最多持续 30 秒。
