# D-Bus 服务

Open Orpheus 在 Linux 上通过会话总线（session bus）提供 MPRIS 播放控制和只读歌词服务，供桌面组件、外部歌词显示及脚本使用。服务随应用启动而注册，不需要额外开关。

> 运行时自省（introspection）是唯一权威的接口定义。本文档以及仓库中检入的 XML 快照仅用于阅读和代码生成；如果二者与运行中的服务不一致，以运行时自省结果为准。

## MPRIS 播放方式

普通安装的服务名称为 `org.mpris.MediaPlayer2.open-orpheus`，对象路径为
`/org/mpris/MediaPlayer2`，播放器接口为 `org.mpris.MediaPlayer2.Player`。
Flatpak 使用 `org.mpris.MediaPlayer2.<FLATPAK_ID>` 作为服务名称。

`Shuffle` 和 `LoopStatus` 均可读写，并通过 `PropertiesChanged` 回报实际状态。
DMS 等客户端写入后，应用等待页面确认对应模式，再完成 D-Bus 调用；页面未就绪、
三秒内未确认或属性值非法时返回错误。应用内切换模式也会同步到 MPRIS。

| 页面播放方式 | `Shuffle` | `LoopStatus` |
| --- | --- | --- |
| 顺序播放 | `false` | `None` |
| 列表循环 | `false` | `Playlist` |
| 单曲循环 | `false` | `Track` |
| 随机播放 | `true` | `Playlist` |

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

模式桥接目前针对 Orpheus 的 webpack 4 页面，通过已初始化的播放 store 读取状态并
调用页面自身的 `playing/switchPlayingMode`。不依赖固定模块编号，不修改资源包。
启动发现有 30 秒上限，连接成功后只订阅状态变化；未来资源包替换其运行框架时需要重新验证。

本机修复验证记录见 [MPRIS 播放方式验收](MPRIS_PLAYBACK_MODE_ACCEPTANCE.md)。

## 歌词服务

| 项目     | 值                                      |
| -------- | --------------------------------------- |
| 总线     | 会话总线（`--session` / `--user`）      |
| 总线名称 | `io.github.yucling.OpenOrpheus`         |
| 对象路径 | `/io/github/yucling/OpenOrpheus/Lyrics` |
| 接口     | `io.github.yucling.OpenOrpheus.Lyrics`  |
| 可用平台 | Linux                                   |
| 权限     | 只读                                    |

### 查看接口定义

```sh
gdbus introspect \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics

busctl --user introspect \
  io.github.yucling.OpenOrpheus \
  /io/github/yucling/OpenOrpheus/Lyrics
```

仓库中也提供了一份由接口自动生成的 XML 快照：
[`docs/resources/dbus/io.github.yucling.OpenOrpheus.Lyrics.xml`](./resources/dbus/io.github.yucling.OpenOrpheus.Lyrics.xml)。

### 快速开始

```sh
# 当前歌词（JSON 字符串）
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method io.github.yucling.OpenOrpheus.Lyrics.GetLyrics

# 指定播放位置（毫秒）对应的歌词行
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method io.github.yucling.OpenOrpheus.Lyrics.GetLineAt \
  12345

# 读取属性
gdbus call \
  --session \
  --dest io.github.yucling.OpenOrpheus \
  --object-path /io/github/yucling/OpenOrpheus/Lyrics \
  --method org.freedesktop.DBus.Properties.Get \
  io.github.yucling.OpenOrpheus.Lyrics \
  Available

busctl --user get-property \
  io.github.yucling.OpenOrpheus \
  /io/github/yucling/OpenOrpheus/Lyrics \
  io.github.yucling.OpenOrpheus.Lyrics \
  Available

# 监听信号
gdbus monitor --session --dest io.github.yucling.OpenOrpheus
```

> **时间单位**：本服务中的所有时间均为**毫秒**。MPRIS 的 `Position` 单位是微秒，使用 MPRIS 定位时请先换算。

### 方法

| 方法        | 参数            | 返回 | 说明                                                   |
| ----------- | --------------- | ---- | ------------------------------------------------------ |
| `GetLyrics` | 无              | `s`  | 当前歌词文档的 JSON；没有歌词时返回字符串 `"null"`     |
| `GetLineAt` | `x position_ms` | `s`  | 指定毫秒位置对应的歌词行 JSON；第一行之前返回 `"null"` |

`GetLyrics` 返回的 JSON 与应用内部的 `LyricsStore` 结构一致（全部时间为毫秒）：

```json
{
  "regular": [
    {
      "start_time": 0,
      "end_time": 5000,
      "words": [{ "text": "hello", "start_time": 0, "duration": 5000 }]
    }
  ],
  "per-word": [
    {
      "start_time": 0,
      "end_time": 5000,
      "words": [
        { "text": "he", "start_time": 0, "duration": 2000 },
        { "text": "llo", "start_time": 2000, "duration": 3000 }
      ]
    }
  ],
  "translate": [],
  "roma": []
}
```

`per-word`、`translate`、`roma` 在不可用时不会出现。`words[].start_time` 相对于所属行。

`GetLineAt` 返回的 JSON：

```json
{
  "index": 0,
  "start_time": 0,
  "end_time": 5000,
  "text": "hello",
  "translation": "你好",
  "roma": null,
  "words": [{ "text": "hello", "start_time": 0, "duration": 5000 }]
}
```

- `index` 是当前行在主要歌词数组（有逐字歌词时为 `per-word`，否则为 `regular`）中的下标。
- 在最后一行结束之后，仍然返回最后一行（与应用内显示行为一致）。
- 缺少翻译/罗马音时对应字段为 `null`。

### 属性

| 属性             | 类型 | 说明                           |
| ---------------- | ---- | ------------------------------ |
| `Available`      | `b`  | 是否存在主要歌词行             |
| `Slogan`         | `s`  | 当前标语，没有时为空字符串     |
| `TrackId`        | `s`  | 当前播放 id，没有时为空字符串  |
| `Title`          | `s`  | 曲目标题                       |
| `Artist`         | `s`  | 曲目艺术家                     |
| `Album`          | `s`  | 曲目专辑                       |
| `Duration`       | `x`  | 曲目时长（毫秒），未知时为 `0` |
| `HasPerWord`     | `b`  | 是否有逐字歌词                 |
| `HasTranslation` | `b`  | 是否有翻译歌词                 |
| `HasRoma`        | `b`  | 是否有罗马音歌词               |

属性变化时会发送标准的 `org.freedesktop.DBus.Properties.PropertiesChanged` 信号。

### 信号

| 信号            | 参数 | 触发时机               |
| --------------- | ---- | ---------------------- |
| `LyricsChanged` | 无   | 歌词文档或标语发生变化 |
| `TrackChanged`  | 无   | 曲目信息或时长发生变化 |

信号不携带数据，收到后重新调用 `GetLyrics` / 读取属性即可。这样可以避免通过总线广播大段歌词。

### JavaScript 客户端示例

```js
import { DbusClient } from "@open-orpheus/dbus";

const bus = new DbusClient("session");
const target = {
  destination: "io.github.yucling.OpenOrpheus",
  path: "/io/github/yucling/OpenOrpheus/Lyrics",
  interfaceName: "io.github.yucling.OpenOrpheus.Lyrics",
};

const lyrics = await bus.call({ ...target, method: "GetLyrics" });
const store = JSON.parse(lyrics.body[0]);

// 传入从 MPRIS 换算得到的毫秒位置
const line = await bus.call({
  ...target,
  method: "GetLineAt",
  signature: "x",
  body: [12345],
});
console.log(JSON.parse(line.body[0]));
```

## 与 MPRIS 的关系

播放状态、进度、控制命令仍由 MPRIS 接口提供（`org.mpris.MediaPlayer2.open-orpheus`）。歌词服务只负责歌词文档、曲目信息和按位置查询，不维护计时器，也不随播放进度持续发送信号。

> 切歌时服务会先清空上一首的歌词与标语，只有渲染进程随后提供新歌词时才会再次出现内容。这样即使没有启用桌面歌词、播放页或迷你播放器，也不会返回上一首的歌词。

## 稳定性

- 在同一接口名下新增方法、属性或信号视为向后兼容变更。
- 破坏性变更会使用新的接口名称，并在发布说明中注明。
- 运行时自省始终优先于本文档和 XML 快照；如果发现不一致，请以实际运行的服务为准并提交 issue。
